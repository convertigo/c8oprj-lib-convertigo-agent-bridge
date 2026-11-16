// The No Code skill of lib_ConvertigoMCP is a folder: SKILL.md, the rules of every turn, and the drawer files its
// `> Drawer` lines name (Vibe shows the model 8,000 characters of a longer tool answer, and a No Code agent reads no
// MCP resource). Every install of a No Code home copies the drawers next to SKILL.md, removes the ones its SKILL.md no
// longer names, and still works with an MCP of before the drawers, which ships SKILL.md alone.
// node --test tests/nocode_skill_drawers.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
global.context = javaProxy;
global.request = javaProxy;
global.log = javaProxy;
global.C8O = { agentBridge: {} };

const root = path.resolve(__dirname, "..");
for (const file of ["agent_bridge_common.js", "agent_bridge_codex.js", "agent_bridge_vibe.js", "agent_bridge_claude.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, "js", file), "utf8"), { filename: file });
}

const ENDPOINT = "https://nocode.example.test/convertigo/api/mcp";
const NOCODE = { userId: "ann@example.test", agentProfile: "nocode", mcpEndpoint: ENDPOINT };
const DRAWERS = ["workflow.md", "sources.md", "errors.md"];

// A source SKILL.md as lib_ConvertigoMCP ships it, naming `drawers`, and the drawer files beside it.
function skillSource(drawers) {
  return [
    "---", "name: convertigo-nocode", "---", "", "# Convertigo No-Code Only", "", "## Drawers", "",
    "Each `> Drawer` line names a file next to this `SKILL.md`.", "",
    "## Skill freshness", "", "- Skill guidance version: `old`.", "",
    "## Convertigo MCP entry", "", "- Expected MCP endpoint: `http://localhost:18082/convertigo/api/mcp`.", "",
    "## Workflow", "",
    ...drawers.map(name => "> Drawer `" + name + "` — " + name.replace(/\.md$/, "") + ": read it before the step."),
    ""
  ].join("\n");
}

// java.io.File over a real temporary folder.
class FakeFile {
  constructor(parent, child) {
    const base = parent instanceof FakeFile ? parent.p : String(parent);
    this.p = child === undefined ? base : path.join(base, String(child));
  }
  exists() { return fs.existsSync(this.p); }
  isFile() { return fs.existsSync(this.p) && fs.statSync(this.p).isFile(); }
  isDirectory() { return fs.existsSync(this.p) && fs.statSync(this.p).isDirectory(); }
  getName() { return path.basename(this.p); }
  getParentFile() { return new FakeFile(path.dirname(this.p)); }
  getCanonicalPath() { return this.p; }
  getAbsolutePath() { return this.p; }
  listFiles() { return this.isDirectory() ? fs.readdirSync(this.p).map(name => new FakeFile(this, name)) : null; }
  delete() { fs.rmSync(this.p); return true; }
}

// A temporary MCP skill source (`drawers` named, `present` on disk) and homes, with the Java file helpers on the disk.
function withSource({ drawers = DRAWERS, present = drawers } = {}, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nocode-skill-drawers-"));
  const source = path.join(dir, "lib_ConvertigoMCP/resources/convertigo-nocode");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "SKILL.md"), skillSource(drawers));
  for (const name of present) fs.writeFileSync(path.join(source, name), "# " + name + "\n\nRead it before the step. Summary: `SKILL.md`, in this folder.\n\n---\n\ntext of " + name + "\n");
  const overrides = {
    File: FakeFile,
    readTextFile: file => (file.isFile() ? fs.readFileSync(file.p, "utf8") : ""),
    writeTextFile: (file, text) => { fs.mkdirSync(path.dirname(file.p), { recursive: true }); fs.writeFileSync(file.p, String(text)); },
    ensureDirectory: file => fs.mkdirSync(file.p, { recursive: true }),
    sha256File: file => crypto.createHash("sha256").update(fs.readFileSync(file.p)).digest("hex"),
    hashShort: text => crypto.createHash("sha256").update(String(text)).digest("hex").substring(0, 16),
    noCodeSkillSourceFile: () => new FakeFile(source, "SKILL.md"),
    mcpProjectGuidanceVersion: () => "2026-11-16.test",
    withManagedMcpSession: options => options,
    patchCodexMcpConfigText: () => ({ status: "unchanged", text: "" }),
    syncClaudeCredentials: () => {},
    claudeCredentialSourceDirs: () => []
  };
  const saved = {};
  for (const [name, value] of Object.entries(overrides)) {
    saved[name] = globalThis[name];
    globalThis[name] = value;
  }
  try {
    return run({ dir, source });
  } finally {
    for (const name of Object.keys(overrides)) globalThis[name] = saved[name];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const skillDirOf = home => path.join(home, "skills/convertigo-nocode");
const listing = dir => fs.readdirSync(dir).sort();

// Each runtime's install of a No Code home: Vibe and the provider runtime copy the folder, Codex delegates to _setupCodex
// (stubbed below as the MCP writes the folder) or, when that is skipped, copies it as Vibe does.
const INSTALLS = {
  vibe: home => installAgentSkills(NOCODE, "vibe", home),
  claude: home => installAgentSkills(NOCODE, "claude", home),
  codex: home => installAgentSkills(Object.assign({ skipMcpProjectSkillSync: true }, NOCODE), "codex", home)
};

test("every runtime installs SKILL.md and each drawer it names next to it", () => {
  withSource({}, ({ dir, source }) => {
    for (const [runtime, install] of Object.entries(INSTALLS)) {
      const home = path.join(dir, runtime + "-home");
      const report = install(home);
      assert.notEqual(report.ok, false, runtime + ": " + report.error);
      const skillDir = skillDirOf(home);
      assert.deepEqual(listing(skillDir), ["SKILL.md", ...DRAWERS].sort(), runtime);
      for (const name of DRAWERS) {
        assert.equal(fs.readFileSync(path.join(skillDir, name), "utf8"), fs.readFileSync(path.join(source, name), "utf8"), runtime + " " + name);
        assert.ok(report.copied.includes("skills/convertigo-nocode/" + name), runtime + " reports " + name);
      }
      const installed = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
      assert.match(installed, /^- Skill guidance version: `2026-11-16\.test`\.$/m, runtime);
      assert.ok(installed.includes("- Expected MCP endpoint: `" + ENDPOINT + "`."), runtime);
      assert.equal(report.skillStatus, "created", runtime);
      // a second install finds the folder current
      const again = install(home);
      assert.equal(again.skillStatus, "unchanged", runtime);
      assert.ok(DRAWERS.every(name => again.reused.includes("skills/convertigo-nocode/" + name)), runtime);
    }
  });
});

test("an install removes the drawers its SKILL.md no longer names, and keeps the other files", () => {
  withSource({}, ({ dir }) => {
    for (const [runtime, install] of Object.entries(INSTALLS)) {
      const home = path.join(dir, runtime + "-home");
      fs.mkdirSync(skillDirOf(home), { recursive: true });
      fs.writeFileSync(path.join(skillDirOf(home), "old-drawer.md"), "# Old\n");
      fs.writeFileSync(path.join(skillDirOf(home), "notes.txt"), "kept\n");
      const report = install(home);
      assert.deepEqual(report.removed, ["skills/convertigo-nocode/old-drawer.md"], runtime);
      assert.deepEqual(listing(skillDirOf(home)), ["SKILL.md", "notes.txt", ...DRAWERS].sort(), runtime);
    }
  });
});

test("an MCP of before the drawers: its single SKILL.md replaces the folder a newer MCP installed", () => {
  withSource({}, ({ dir, source }) => {
    for (const [runtime, install] of Object.entries(INSTALLS)) {
      install(path.join(dir, runtime + "-home"));
    }
    // the older MCP: SKILL.md alone, naming no drawer
    fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: convertigo-nocode\n---\n\n# Convertigo No-Code Only\n\nThe whole skill.\n");
    for (const name of DRAWERS) fs.rmSync(path.join(source, name));
    for (const [runtime, install] of Object.entries(INSTALLS)) {
      const home = path.join(dir, runtime + "-home");
      const report = install(home);
      assert.notEqual(report.ok, false, runtime);
      assert.deepEqual(listing(skillDirOf(home)), ["SKILL.md"], runtime);
      assert.deepEqual([...report.removed].sort(), DRAWERS.map(name => "skills/convertigo-nocode/" + name).sort(), runtime);
      assert.match(fs.readFileSync(path.join(skillDirOf(home), "SKILL.md"), "utf8"), /The whole skill\./, runtime);
    }
  });
});

test("Codex through _setupCodex: a new MCP writes the folder, an older one SKILL.md alone and the Bridge removes the rest", () => {
  withSource({}, ({ dir, source }) => {
    const home = path.join(dir, "codex-home");
    let writes = DRAWERS;
    const saved = setupCodexFromMcpProject;
    setupCodexFromMcpProject = (_options, codexHome) => {
      const skillDir = path.join(codexHome.p, "skills/convertigo-nocode");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillSource(writes));
      for (const name of writes) fs.copyFileSync(path.join(source, name), path.join(skillDir, name));
      return { attempted: true, ok: true, skillStatus: "created", configStatus: "unchanged", resolvedCodexHome: codexHome.p,
        resolvedMcpUrl: ENDPOINT, skillPath: path.join(skillDir, "SKILL.md"), warnings: [], source: "lib_ConvertigoMCP._setupCodex", message: "synchronized" };
    };
    try {
      const fresh = installAgentSkills(NOCODE, "codex", home);
      assert.equal(fresh.ok, true, fresh.error);
      assert.equal(fresh.removed, undefined);
      assert.deepEqual(listing(skillDirOf(home)), ["SKILL.md", ...DRAWERS].sort());
      writes = [];
      const older = installAgentSkills(NOCODE, "codex", home);
      assert.equal(older.ok, true, older.error);
      assert.deepEqual([...older.removed].sort(), DRAWERS.map(name => "skills/convertigo-nocode/" + name).sort());
      assert.deepEqual(listing(skillDirOf(home)), ["SKILL.md"]);
    } finally {
      setupCodexFromMcpProject = saved;
    }
  });
});

test("a drawer SKILL.md names but the MCP lacks is a warning; the skill and the other drawers are installed", () => {
  withSource({ present: ["workflow.md", "errors.md"] }, ({ dir }) => {
    for (const [runtime, install] of Object.entries(INSTALLS)) {
      const home = path.join(dir, runtime + "-home");
      const report = install(home);
      assert.notEqual(report.ok, false, runtime);
      assert.deepEqual(listing(skillDirOf(home)), ["SKILL.md", "errors.md", "workflow.md"], runtime);
      assert.ok((report.warnings || []).some(w => /No Code skill drawer not found beside .*: sources\.md$/.test(w)), runtime + ": " + JSON.stringify(report.warnings));
    }
  });
});

test("a dry run reports the drawers it would write and remove, and writes nothing", () => {
  withSource({}, ({ dir }) => {
    const home = path.join(dir, "claude-home");
    fs.mkdirSync(skillDirOf(home), { recursive: true });
    fs.writeFileSync(path.join(skillDirOf(home), "old-drawer.md"), "# Old\n");
    const report = installAgentSkills(Object.assign({ dryRun: true }, NOCODE), "claude", home);
    assert.deepEqual(report.removed, ["skills/convertigo-nocode/old-drawer.md"]);
    assert.ok(DRAWERS.every(name => report.copied.includes("skills/convertigo-nocode/" + name)));
    assert.deepEqual(listing(skillDirOf(home)), ["old-drawer.md"]);
  });
});

test("the MCP catalog revision of a Vibe url follows a change of a drawer too", () => {
  withSource({}, ({ source }) => {
    const before = managedMcpCatalogRevision(NOCODE);
    assert.ok(before.length > 0);
    fs.appendFileSync(path.join(source, "sources.md"), "a new rule\n");
    assert.notEqual(managedMcpCatalogRevision(NOCODE), before);
  });
});

test("a No Code Vibe reads the skill folder under every confining policy, and only that and the saved tool results under mcp-only", () => {
  const saved = noCodeToolPolicyName;
  try {
    for (const policy of ["mcp-only", "files", "sandboxed-shell"]) {
      noCodeToolPolicyName = () => policy;
      const tables = vibeToolPolicyTables(NOCODE, "/srv/vibe/users/ann").join("\n");
      assert.match(tables, /\[tools\.read_file\][^[]*allowlist = \[[^\]]*"\/srv\/vibe\/users\/ann\/skills\/convertigo-nocode\/\*"/, policy);
      assert.equal(/permission = "never"/.test(tables), policy === "mcp-only", policy);
      assert.doesNotMatch(vibeToolPolicyLines(NOCODE).join("\n"), /"read_file"/, policy + ": read_file is offered");
    }
  } finally {
    noCodeToolPolicyName = saved;
  }
});
