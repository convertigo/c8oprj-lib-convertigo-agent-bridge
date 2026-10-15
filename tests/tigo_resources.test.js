const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm"),
  cp = require("node:child_process");
const source = fs.readFileSync(
  path.join(__dirname, "../js/agent_bridge_resources.js"),
  "utf8",
);
const secret = "PRIVATE-TEST-VALUE",
  handle =
    "lib_ConvertigoAssistant.resources.12345678-1234-1234-1234-123456789abc";
const connections = [
  {
    name: "tigo_ab12",
    transport: "http",
    url: "https://example.com/mcp",
    env: [],
    headers: { Authorization: { env: "COMPANY_KEY", prefix: "Bearer " } },
    envValues: { COMPANY_KEY: secret },
  },
  {
    name: "tigo_cd34",
    transport: "stdio",
    command: "C:\\Program Files\\Tools\\mcp.exe",
    args: ["--mode", "read"],
    env: ["COMPANY_KEY"],
    headers: {},
    envValues: { COMPANY_KEY: secret },
  },
];
function fixture(bundle = { expiresAt: 200, connections }) {
  const s = {
    trim: (v) => String(v ?? "").trim(),
    optionOrRequest: (o, k) => o[k] || "",
    serverSecretGet: (h) => (h === handle ? JSON.stringify(bundle) : ""),
    now: () => 100,
    splitTextLines: (v) => v.split("\n"),
    tomlEscape: (v) => JSON.stringify(v).slice(1, -1),
    tomlArray: (v) => JSON.stringify(v),
  };
  vm.runInNewContext(source, s);
  return s;
}
const plain = (v) => JSON.parse(JSON.stringify(v));
test("Codex writes isolated named servers with environment references and preserves managed entries", () => {
  const s = fixture();
  const old =
    'model = "example"\n[mcp_servers.convertigo]\nurl="http://localhost/mcp"\n[mcp_servers.tigo_deadbeef]\ncommand="old"\n';
  const config = s.patchTigoCodexConfig(old, { tigoResourcesHandle: handle });
  assert.match(config, /mcp_servers.convertigo/);
  assert.doesNotMatch(config, /command="old"|PRIVATE-TEST-VALUE/);
  const p = cp.spawnSync(
    "python3",
    [
      "-c",
      "import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))",
    ],
    { input: config, encoding: "utf8" },
  );
  assert.equal(p.status, 0, p.stderr);
  const parsed = JSON.parse(p.stdout);
  assert.equal(
    parsed.mcp_servers.tigo_ab12.env_http_headers.Authorization,
    "TIGO_MCP_AB12_AUTHORIZATION",
  );
  assert.equal(parsed.mcp_servers.tigo_cd34.command, connections[1].command);
  assert.deepEqual(parsed.mcp_servers.tigo_cd34.env_vars, ["COMPANY_KEY"]);
  const clean = s.patchTigoCodexConfig(config, { tigoResourcesHandle: handle });
  assert.equal(clean, config, "idempotent");
});
test("Claude JSON contains interpolation placeholders and never private credentials", () => {
  const s = fixture(),
    result = s.addTigoClaudeServers(
      { convertigo: { type: "http", url: "http://localhost/mcp" } },
      { tigoResourcesHandle: handle },
    );
  assert.equal(
    result.tigo_ab12.headers.Authorization,
    "${TIGO_MCP_AB12_AUTHORIZATION}",
  );
  assert.equal(result.tigo_cd34.env.COMPANY_KEY, "${COMPANY_KEY}");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-TEST-VALUE/);
});
test("Vibe ACP uses http and stdio protocol shapes with transient authorization", () => {
  const s = fixture(),
    servers = plain(s.tigoVibeServers({ tigoResourcesHandle: handle }));
  assert.equal(servers[0].headers[0].value, "Bearer " + secret);
  assert.equal(servers[0].type, "http");
  assert.equal(servers[1].type, undefined);
  assert.deepEqual(servers[1].env, [{ name: "COMPANY_KEY", value: secret }]);
});
test("secret environment is derived from the private handle, which fails closed when missing or expired", () => {
  const s = fixture(),
    env = s.applyTigoMcpEnvironment(
      { CONVERTIGO_MCP_TOKEN: "managed" },
      { tigoResourcesHandle: handle },
    );
  assert.equal(env.COMPANY_KEY, secret);
  assert.equal(env.TIGO_MCP_AB12_AUTHORIZATION, "Bearer " + secret);
  assert.equal(env.CONVERTIGO_MCP_TOKEN, "managed");
  assert.throws(
    () => s.tigoMcpConnections({ tigoResourcesHandle: "invalid" }),
    /Invalid Tigo/,
  );
  assert.throws(
    () =>
      fixture({ expiresAt: 0, connections }).tigoMcpConnections({
        tigoResourcesHandle: handle,
      }),
    /expired/,
  );
  assert.deepEqual(plain(s.tigoMcpConnections({})), []);
});
