// The No Code per-user gateway key (tigo-nocode-contract.md section 8): on a server whose C8Oforms issues one key per
// user (APIV2_TigoUserKey), a No Code agent on the Convertigo gateway runs on its user's key only. The key comes from a
// server-memory handle, reaches the process environment only, never a home .env or the key file, and nothing falls
// back to the server key. An agent that could read another agent's /proc/<pid>/environ does not run.
// node --test tests/nocode_user_gateway_key.test.js
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

const USER_KEY = "sk-user-" + "a".repeat(32);
const SERVER_KEY = "sk-server-" + "b".repeat(32);
const HANDLE = "lib_ConvertigoAssistant.gatewayKey.0123456789abcdef";

function load({ studio = false, userKeySequence = true, registered = true, store = {}, files = {} } = {}) {
  const map = new Map(Object.entries(store));
  const server = { get: (key) => (map.has(key) ? map.get(key) : null), set: (key, value) => map.set(key, value), remove: (key) => map.delete(key) };
  const sandbox = { Packages: javaProxy, context: { server }, request: javaProxy, log: javaProxy, C8O: { agentBridge: {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "js/agent_bridge_common.js"), "utf8"), sandbox, { filename: "agent_bridge_common.js" });
  sandbox.Engine = {
    isStudioMode: () => studio,
    theApp: { databaseObjectsManager: {
      getOriginalProjectByName: (name) => (name === "C8Oforms"
        ? { getSequenceByName: (sequence) => (sequence === "APIV2_TigoUserKey" && userKeySequence ? {} : null) } : null),
      symbolsGetValue: (name) => (name === "C8Oforms.tigo.server.id" && registered ? "server-test" : null)
    } }
  };
  sandbox.now = () => Date.now();
  sandbox.gatewayKeyFingerprint = (key) => require("node:crypto").createHash("sha256").update(String(key)).digest("hex").slice(0, 16);
  sandbox.requestParameter = () => "";
  sandbox.resolveProjectIdOption = () => "";
  sandbox.projectUsesFlow = () => false;
  // the server key everywhere the Studio path reads one: the key file and a home .env
  sandbox.readConvertigoGatewayKeyFile = () => SERVER_KEY;
  sandbox.readEnvFile = () => ({ values: { CONVERTIGO_LLM_API_KEY: SERVER_KEY }, keys: ["CONVERTIGO_LLM_API_KEY"], exists: true, path: "x" });
  const written = [];
  sandbox.writeEnvFileValue = (file, name, value) => written.push([String(file && file.p), name, value]);
  sandbox.readTextFile = (file) => files[file.p];
  sandbox.writeTextFile = (file, text) => { files[file.p] = text; written.push([file.p, "*", text]); };
  return { sandbox, map, written, files };
}

const bundle = (overrides = {}) => JSON.stringify(Object.assign({ key: USER_KEY, owner: "ann@example.com", expiresAt: Date.now() + 600000 }, overrides));
const NOCODE = { userId: "ann@example.com", skillProfile: "nocode", vibeProfile: "convertigo", provider: "vibe" };

test("the per-user path is on for a No Code session on a server whose C8Oforms issues user keys, only", () => {
  assert.equal(load().sandbox.userGatewayKeysOn(NOCODE), true);
  assert.equal(load({ studio: true }).sandbox.userGatewayKeysOn(NOCODE), false, "the Studio keeps its key file");
  assert.equal(load({ userKeySequence: false }).sandbox.userGatewayKeysOn(NOCODE), false, "a C8Oforms without user keys keeps the server key");
  assert.equal(load({ registered: false }).sandbox.userGatewayKeysOn(NOCODE), false,
    "a server not registered with TigoAccess yet (not_configured) keeps its shared key");
  assert.equal(load().sandbox.userGatewayKeysOn({ userId: "studio", skillProfile: "generalist" }), false, "a Studio session");
});

test("the user's key comes from its server-memory handle, and from nowhere else", () => {
  const { sandbox } = load({ store: { [HANDLE]: bundle() } });
  const credential = sandbox.userGatewayCredential(Object.assign({ gatewayKeyHandle: HANDLE }, NOCODE));
  assert.equal(credential.reason, "ok");
  assert.equal(credential.key, USER_KEY);
  assert.equal(credential.fingerprint.length, 16);
  assert.equal(sandbox.convertigoGatewayApiKey(Object.assign({ gatewayKeyHandle: HANDLE }, NOCODE), "/home"), USER_KEY);
  // no handle, or a raw key in the options: no key at all, never the key file or the home .env
  assert.equal(sandbox.convertigoGatewayApiKey(NOCODE, "/home"), "");
  assert.equal(sandbox.convertigoGatewayApiKey(Object.assign({ gatewayApiKey: SERVER_KEY }, NOCODE), "/home"), "");
  // the Studio keeps its key file
  assert.equal(load({ studio: true }).sandbox.convertigoGatewayApiKey(NOCODE, "/home"), SERVER_KEY);
});

test("a missing, malformed, expired or foreign handle gives no key", () => {
  const reasons = {};
  const cases = {
    missing: [{}, {}],
    invalid: [{ [HANDLE]: bundle() }, { gatewayKeyHandle: "lib_ConvertigoAssistant.resources.x" }],
    expired: [{ [HANDLE]: bundle({ expiresAt: Date.now() - 1 }) }, { gatewayKeyHandle: HANDLE }],
    gone: [{}, { gatewayKeyHandle: HANDLE }],
    foreign: [{ [HANDLE]: bundle({ owner: "bob@example.com" }) }, { gatewayKeyHandle: HANDLE }],
    notakey: [{ [HANDLE]: bundle({ key: "not-a-key" }) }, { gatewayKeyHandle: HANDLE }]
  };
  for (const [name, [store, options]] of Object.entries(cases)) {
    const credential = load({ store }).sandbox.userGatewayCredential(Object.assign({}, NOCODE, options));
    assert.equal(credential.key, "", name);
    reasons[name] = credential.reason;
  }
  assert.deepEqual(reasons, { missing: "missing", invalid: "invalid", expired: "expired", gone: "expired", foreign: "foreign", notakey: "invalid" });
});

test("a gateway start without the user's key is refused, fail closed; other runtimes and the Studio are not concerned", () => {
  const { sandbox } = load();
  const refused = sandbox.userGatewayKeyRefusal(NOCODE, "vibe");
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "gateway_credential_missing");
  assert.equal(refused.reason, "missing");
  assert.doesNotMatch(JSON.stringify(refused), /sk-/);
  assert.equal(sandbox.userGatewayKeyRefusal(Object.assign({}, NOCODE, { vibeProfile: "mistral" }), "vibe"), null, "Vibe on Mistral uses no gateway key");
  assert.equal(sandbox.userGatewayKeyRefusal(Object.assign({}, NOCODE, { model: "mistral/zai-glm-5-3" }), "claude").code, "gateway_credential_missing",
    "Claude Code on a gateway model");
  assert.equal(sandbox.userGatewayKeyRefusal(Object.assign({}, NOCODE, { model: "claude-sonnet-5-5" }), "claude"), null, "Claude's own sign-in");
  assert.equal(load({ studio: true }).sandbox.userGatewayKeyRefusal(NOCODE, "vibe"), null);
  assert.equal(load({ store: { [HANDLE]: bundle() } }).sandbox.userGatewayKeyRefusal(Object.assign({ gatewayKeyHandle: HANDLE }, NOCODE), "vibe"), null);
});

test("the process environment gets the user's key in place of anything the engine or a home .env held", () => {
  const { sandbox } = load({ store: { [HANDLE]: bundle() } });
  const env = { CONVERTIGO_LLM_API_KEY: SERVER_KEY, CONVERTIGO_LLM_API_KEY_FILE_SHA: "abc", MISTRAL_API_KEY: "m" };
  const applied = sandbox.applyUserGatewayKey(env, Object.assign({ gatewayKeyHandle: HANDLE }, NOCODE), "vibe");
  assert.equal(env.CONVERTIGO_LLM_API_KEY, USER_KEY);
  assert.equal(env.CONVERTIGO_LLM_API_KEY_FILE_SHA, undefined);
  assert.equal(env.MISTRAL_API_KEY, "m");
  assert.equal(applied.on, true);
  assert.equal(applied.handle, HANDLE);
  assert.deepEqual(Array.from(applied.unset), ["CONVERTIGO_LLM_API_KEY", "CONVERTIGO_LLM_API_KEY_FILE_SHA"], "never inherited from the engine");
  // no key: none at all, and the engine's own variable is not inherited either
  const bare = { CONVERTIGO_LLM_API_KEY: SERVER_KEY };
  const none = load().sandbox.applyUserGatewayKey(bare, NOCODE, "vibe");
  assert.equal(bare.CONVERTIGO_LLM_API_KEY, undefined);
  assert.equal(none.fingerprint, "");
  // Claude Code on a gateway model takes it as ANTHROPIC_AUTH_TOKEN (claudeStart), not as the gateway variable
  const claudeEnv = {};
  load({ store: { [HANDLE]: bundle() } }).sandbox.applyUserGatewayKey(claudeEnv, Object.assign({ gatewayKeyHandle: HANDLE, model: "mistral/zai-glm-5-3" }, NOCODE), "claude");
  assert.equal(claudeEnv.CONVERTIGO_LLM_API_KEY, undefined);
  // the Studio path is untouched
  const studioEnv = { CONVERTIGO_LLM_API_KEY: SERVER_KEY };
  assert.equal(load({ studio: true }).sandbox.applyUserGatewayKey(studioEnv, NOCODE, "vibe").on, false);
  assert.equal(studioEnv.CONVERTIGO_LLM_API_KEY, SERVER_KEY);
});

test("no key is written to a home: the server key a home .env still holds is removed, its other lines stay", () => {
  const files = { "/home/.env": "MISTRAL_API_KEY=m\nCONVERTIGO_LLM_API_KEY=" + SERVER_KEY + "\nexport CONVERTIGO_LLM_API_KEY_FILE_SHA=abc\nOTHER=1" };
  const { sandbox, written } = load({ files });
  const file = { p: "/home/.env", isFile: () => true };
  assert.equal(sandbox.scrubGatewayKeyFromEnvFile(file), true);
  assert.equal(files["/home/.env"], "MISTRAL_API_KEY=m\nOTHER=1");
  assert.equal(sandbox.scrubGatewayKeyFromEnvFile(file), false, "nothing left to remove");
  assert.ok(!written.some((entry) => String(entry[2]).includes(USER_KEY)), "the user's key is never written");
  // bootstrapVibeHome takes the per-user branch before the key file synchronization
  const source = fs.readFileSync(path.join(root, "js/agent_bridge_common.js"), "utf8");
  assert.match(source, /if \(userGatewayKeysOn\(options\)\) \{\n\s+\/\/ the user's key reaches the process environment only \(applyUserGatewayKey\)\n\s+report\.gatewayKey = scrubGatewayKeyFromEnvFile\(new File\(homeDir, "\.env"\)\)/);
  assert.match(source, /\} else if \(isConvertigoGatewayProfile\(options\)\) \{\n\s+report\.gatewayKey = syncConvertigoGatewayKey\(options, homeDir, report\)\.reason;/);
  // a key sent to vibeGatewayKeyStore is refused rather than stored
  const vibe = fs.readFileSync(path.join(root, "js/agent_bridge_vibe.js"), "utf8");
  assert.match(vibe, /C8O\.agentBridge\.vibeGatewayKeyStore = function \(options\) \{\n\s+options = optionsWithRequestFallbacks\(options \|\| \{\}\);\n\s+if \(userGatewayKeysOn\(options\)\) \{/);
});

test("settings and setup see the user's key as the authentication of the convertigo profile", () => {
  const { sandbox } = load({ store: { [HANDLE]: bundle() } });
  assert.equal(sandbox.inspectVibeAuthentication("/home", "convertigo", Object.assign({ gatewayKeyHandle: HANDLE }, NOCODE)).method, "user_key");
  assert.equal(sandbox.inspectVibeAuthentication("/home", "convertigo", NOCODE).status, "managed", "a settings read without the key");
  const gone = sandbox.inspectVibeAuthentication("/home", "convertigo", Object.assign({ gatewayKeyHandle: HANDLE.replace("0123", "9999") }, NOCODE));
  assert.equal(gone.configured, false);
  assert.equal(gone.status, "user_key_unavailable");
});

test("with per-user keys, an agent that could read another agent's environment does not run", () => {
  const { sandbox } = load();
  assert.equal(sandbox.userGatewayKeyIsolationRefusal(NOCODE, "vibe", { confined: true, policy: "files" }), null, "Landlock");
  assert.equal(sandbox.userGatewayKeyIsolationRefusal(NOCODE, "vibe", { confined: false, policy: "mcp-only" }), null, "no native tool");
  for (const [provider, sandboxInfo] of [["vibe", null], ["vibe", { confined: false, policy: "files" }], ["claude", null], ["codex", null]]) {
    const refused = sandbox.userGatewayKeyIsolationRefusal(NOCODE, provider, sandboxInfo);
    assert.equal(refused && refused.code, "agent_isolation_unavailable", provider + " " + JSON.stringify(sandboxInfo));
  }
  assert.equal(load({ studio: true }).sandbox.userGatewayKeyIsolationRefusal(NOCODE, "claude", null), null);
  assert.equal(load({ userKeySequence: false }).sandbox.userGatewayKeyIsolationRefusal(NOCODE, "codex", null), null);
});

test("every runtime applies it: start refusals, restart on a new key, key kept on the entry by handle only", () => {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const vibe = read("js/agent_bridge_vibe.js");
  assert.match(vibe, /var gatewayKeyRefusal = userGatewayKeyRefusal\(options, "vibe"\);/);
  assert.match(vibe, /var isolationRefusal = userGatewayKeyIsolationRefusal\(options, "vibe", noCodeSandbox\);/);
  assert.match(vibe, /var userGatewayKey = applyUserGatewayKey\(env, options, "vibe"\);/);
  assert.match(vibe, /\} else if \(gatewayKeyChanged\) \{[\s\S]{0,400}reason: "gateway_key_changed"/);
  assert.match(vibe, /var gatewayKeyRefusal = userGatewayKeyRefusal\(entryGatewayKeyOptions\(entry, options\), "vibe"\);/, "at each prompt");
  assert.match(vibe, /\? userGatewayCredential\(entryGatewayKeyOptions\(entry, deps\.options\)\)\.key/, "image description on the user's key");
  const claude = read("js/agent_bridge_claude.js");
  assert.match(claude, /var gatewayKeyRefusal = userGatewayKeyIsolationRefusal\(options, "claude", null\) \|\| userGatewayKeyRefusal\(options, "claude"\);/);
  assert.match(claude, /\|\| viewerChanged \|\| gatewayKeyChanged\) \{/);
  assert.match(claude, /restartOptions\.gatewayKeyHandle = /);
  assert.match(read("js/agent_bridge_codex.js"), /var isolationRefusal = userGatewayKeyIsolationRefusal\(options, "codex", null\);/);
  const common = read("js/agent_bridge_common.js");
  assert.match(common, /\(entry\.unsetEnv \|\| \[\]\)\.forEach\(function \(name\) \{ pb\.environment\(\)\.remove\(String\(name\)\); \}\);\n\s+envObjectToMap\(pb\.environment\(\), env\);/);
  for (const file of ["js/agent_bridge_vibe.js", "js/agent_bridge_claude.js"]) {
    const source = read(file);
    assert.doesNotMatch(source, /entry\.gatewayKey\s*=/, file + " keeps no key on its entry");
    assert.match(source, /entry\.gatewayKeyHandle = userGatewayKey\.handle;/, file);
  }
});

test("the sequences that start, prompt, set up or read an agent take the handle as a masked variable", () => {
  for (const [name, fn] of [["agent_vibe_start", "vibeStart"], ["agent_vibe_prompt", "vibePrompt"], ["agent_vibe_setup", "vibeSetup"],
    ["agent_claude_start", "claudeStart"], ["agent_claude_prompt", "claudePrompt"], ["agent_settings", "settings"]]) {
    const yaml = fs.readFileSync(path.join(root, "_c8oProject/sequences", name + ".yaml"), "utf8");
    assert.match(yaml, new RegExp("result = C8O\\.agentBridge\\." + fn + "\\(\\{\\n {6}gatewayKeyHandle: typeof gatewayKeyHandle === \"undefined\" \\? \"\" : gatewayKeyHandle,"), name);
    assert.match(yaml, /↓gatewayKeyHandle \[variables\.RequestableVariable-\d+\]: \n  comment: [^\n]+\n  value: \n    - ↑ciphered: true\n    - ↑traceable: false\n    - →→: xd8e180806a1c1d83a6255212121ab827\n  visibility: 15/, name);
  }
});

test("once seen, the per-user path stays on: a C8Oforms reloaded without the sequence never brings the server key back", () => {
  let available = true;
  const { sandbox } = load();
  sandbox.Engine.theApp.databaseObjectsManager.getOriginalProjectByName = (name) => (name === "C8Oforms"
    ? { getSequenceByName: (sequence) => (sequence === "APIV2_TigoUserKey" && available ? {} : null) } : null);
  assert.equal(sandbox.userGatewayKeysOn(NOCODE), true);
  available = false;
  assert.equal(sandbox.userGatewayKeysOn(NOCODE), true, "until the engine restarts");
  assert.equal(sandbox.convertigoGatewayApiKey(NOCODE, "/home"), "", "still no server key");
  assert.equal(sandbox.userGatewayKeyIsolationRefusal(NOCODE, "claude", null).code, "agent_isolation_unavailable", "still no unconfined agent");
  assert.equal(load({ userKeySequence: false }).sandbox.userGatewayKeysOn(NOCODE), false, "never seen: the server key as before");
});

test("the owner is required on both sides, and a key past its lifetime only serves the process that already holds it", () => {
  const noOwner = load({ store: { [HANDLE]: bundle({ owner: "" }) } });
  assert.equal(noOwner.sandbox.userGatewayCredential(Object.assign({ gatewayKeyHandle: HANDLE }, NOCODE)).reason, "foreign");
  const noUser = load({ store: { [HANDLE]: bundle() } });
  assert.equal(noUser.sandbox.userGatewayCredential({ gatewayKeyHandle: HANDLE, skillProfile: "nocode" }).reason, "foreign");
  const stale = load({ store: { [HANDLE]: bundle({ expiresAt: Date.now() - 1000 }) } });
  const held = stale.sandbox.gatewayKeyFingerprint(USER_KEY);
  assert.equal(stale.sandbox.userGatewayCredential(Object.assign({ gatewayKeyHandle: HANDLE }, NOCODE)).reason, "expired", "no new start on it");
  assert.equal(stale.sandbox.userGatewayCredential(Object.assign({ gatewayKeyHandle: HANDLE, acceptFingerprint: held }, NOCODE)).key, USER_KEY,
    "the running process goes on with the key it holds");
  assert.equal(stale.sandbox.userGatewayCredential(Object.assign({ gatewayKeyHandle: HANDLE, acceptFingerprint: "0000000000000000" }, NOCODE)).reason, "expired");
  const entry = { provider: "vibe", vibeProfile: "convertigo", model: "glm-5-3", gatewayKeyHandle: HANDLE, ownerKey: "ann@example.com", gatewayKeyFingerprint: held };
  assert.equal(stale.sandbox.userGatewayKeyRefusal(stale.sandbox.entryGatewayKeyOptions(entry, {}), "vibe"), null, "its prompt is not refused");
});

test("a key an agent printed never travels in an event of the Bridge", () => {
  const { sandbox } = load({ store: { [HANDLE]: bundle() } });
  const events = [];
  const entry = { provider: "vibe", vibeProfile: "convertigo", userGatewayKeys: true, gatewayKeyHandle: HANDLE,
    gatewayKeyFingerprint: sandbox.gatewayKeyFingerprint(USER_KEY), nextIndex: 0, firstIndex: 0,
    events: { add(event) { events.push(event); }, size() { return events.length; }, remove() { events.shift(); } } };
  sandbox.pushEvent(entry, "tool/update", { toolCallId: "t1", detail: "CONVERTIGO_LLM_API_KEY=" + USER_KEY + "\nHOME=/x", nested: [{ text: "key " + USER_KEY }] });
  sandbox.pushEvent(entry, "stderr", { line: "debug " + USER_KEY });
  sandbox.pushEvent(entry, "message/delta", { text: "nothing secret" });
  assert.doesNotMatch(JSON.stringify(events), new RegExp(USER_KEY));
  assert.equal(events[0].data.detail, "CONVERTIGO_LLM_API_KEY=sk-***\nHOME=/x");
  assert.equal(events[0].data.nested[0].text, "key sk-***");
  assert.equal(events[1].data.line, "debug sk-***");
  assert.equal(events[2].data.text, "nothing secret");
});

test("the gateway's refusal of a user's key does not point at the server key file", () => {
  const source = fs.readFileSync(path.join(root, "js/agent_bridge_common.js"), "utf8");
  assert.match(source, /convertigoGatewayKeyRejected = \(gatewayStatus === 401 \|\| gatewayStatus === 403\) && !userGatewayKeysOn\(options\);/);
});
