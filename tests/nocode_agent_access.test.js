// The Tigo right of the No Code Studio, checked again by the Bridge: a No Code agent whose MCP token C8Oforms refuses
// with agent_not_allowed (the user lost the right tigo_rights) does not start and takes no prompt.
// node --test tests/nocode_agent_access.test.js
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

function load({ c8oforms = true, accessSequence = true, answer = { status: "ok" }, token = "h.p.s" } = {}) {
  const sandbox = { Packages: javaProxy, context: javaProxy, request: javaProxy, log: javaProxy, C8O: { agentBridge: {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "js/agent_bridge_common.js"), "utf8"), sandbox, { filename: "agent_bridge_common.js" });
  const calls = [];
  const project = {
    getSequenceByName(name) {
      if (name === "APIV2_AgentAccess" && !accessSequence) throw new Error("no sequence");
      return {};
    }
  };
  sandbox.Engine = { theApp: { databaseObjectsManager: { getOriginalProjectByName: (name) => (c8oforms && name === "C8Oforms" ? project : null) } } };
  sandbox.noCodeMcpBearerToken = () => token;
  sandbox.callLocalSequence = (projectName, sequence, variables) => {
    calls.push([projectName, sequence, variables]);
    if (answer instanceof Error) throw answer;
    return { document: { result: answer } };
  };
  return { sandbox, calls };
}

const NOCODE = { skillProfile: "nocode", nocodeMcpTokenHandle: "handle" };

test("a No Code agent whose token C8Oforms refuses with agent_not_allowed is refused", () => {
  const { sandbox, calls } = load({ answer: { status: "error", error: { code: "agent_not_allowed" } } });
  const refused = sandbox.noCodeAgentRefusal(NOCODE);
  assert.equal(refused.ok, false);
  assert.equal(refused.status, "failed");
  assert.equal(refused.code, "agent_not_allowed");
  assert.match(refused.error, /^agent_not_allowed: Tigo is not enabled for this account/);
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [["C8Oforms", "APIV2_McpTokenValidate"]]);
  assert.equal(JSON.stringify(calls[0][2]), JSON.stringify({ signingInput: "h.p", signature: "s" }), "the signed parts of the token");
});

test("the Bridge does not decide otherwise: valid token, another refusal, no token, a Studio session, an older C8Oforms", () => {
  assert.equal(load().sandbox.noCodeAgentRefusal(NOCODE), null, "valid token");
  assert.equal(load({ answer: { status: "error", error: { code: "expired_token" } } }).sandbox.noCodeAgentRefusal(NOCODE), null,
    "the Assistant renews the token, the MCP refuses it");
  assert.equal(load({ answer: new Error("down") }).sandbox.noCodeAgentRefusal(NOCODE), null);
  const noToken = load({ token: "" });
  assert.equal(noToken.sandbox.noCodeAgentRefusal(NOCODE), null);
  assert.equal(noToken.calls.length, 0);
  const studio = load({ answer: { status: "error", error: { code: "agent_not_allowed" } } });
  assert.equal(studio.sandbox.noCodeAgentRefusal({ skillProfile: "generalist" }), null);
  assert.equal(studio.sandbox.noCodeAgentRefusal(undefined), null, "an entry started before the check");
  assert.equal(studio.calls.length, 0);
  for (const older of [{ c8oforms: false }, { accessSequence: false }]) {
    const { sandbox, calls } = load({ ...older, answer: { status: "error", error: { code: "agent_not_allowed" } } });
    assert.equal(sandbox.noCodeAgentRefusal(NOCODE), null, JSON.stringify(older));
    assert.equal(calls.length, 0);
  }
});

test("every provider checks at start and at each prompt, and a running entry keeps what the check needs", () => {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const vibe = read("js/agent_bridge_vibe.js");
  assert.match(vibe, /function vibeStartSteps\(options\) \{\n    var noCodeRefusal = noCodeAgentRefusal\(options\);/);
  assert.match(vibe, /entry\.noCodeAccess = noCodeAccessOptions\(options\);/);
  assert.match(vibe, /var noCodeRefusal = noCodeAgentRefusal\(entry\.noCodeAccess\);/);
  for (const [file, name] of [["js/agent_bridge_codex.js", "codex"], ["js/agent_bridge_claude.js", "claude"]]) {
    const source = read(file);
    assert.match(source, new RegExp(`C8O\\.agentBridge\\.${name}Start = function \\(options\\) \\{\\n    var operationStartedAt = now\\(\\);\\n    options = optionsWithRequestFallbacks\\(options \\|\\| \\{\\}\\);\\n    var noCodeRefusal = noCodeAgentRefusal\\(options\\);`), name);
    assert.match(source, /var noCodeRefusal = noCodeAgentRefusal\(\{ skillProfile: entry\.skillProfile, nocodeMcpTokenHandle: entry\.nocodeMcpTokenHandle \}\);/, name);
  }
  const { sandbox } = load();
  assert.equal(JSON.stringify(sandbox.noCodeAccessOptions({ skillProfile: "nocode", mcpBearerTokenHandle: " h " })),
    JSON.stringify({ skillProfile: "nocode", nocodeMcpTokenHandle: "h" }));
});
