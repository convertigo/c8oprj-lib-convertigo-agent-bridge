const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const commonSource = fs.readFileSync("js/agent_bridge_common.js", "utf8");

// Model Windows File canonicalization failures without claiming a native Windows run.
// Runtime detection must never spawn a CLI just to find an executable on disk.
function runtimeSearch({ windows = true, systemPath = "", files = [], denied = [] } = {}) {
  const paths = windows ? path.win32 : path.posix;
  const cwd = windows ? "C:\\Studio" : "/studio";
  const canonicalCalls = [];
  const resolve = value => paths.resolve(cwd, value);
  const existing = new Set(files.map(resolve));
  const inaccessible = new Set(denied.map(resolve));
  function invalid(value) {
    return windows && (/["<>|*?\u0000]/.test(value) || /:/.test(value.replace(/^[A-Za-z]:/, "")));
  }
  function File(parent, child) {
    const base = parent instanceof File ? parent.value : String(parent);
    this.value = child === undefined ? base : paths.join(base, String(child));
  }
  File.pathSeparator = windows ? ";" : ":";
  File.separator = windows ? "\\" : "/";
  File.prototype.getPath = function () { return this.value; };
  File.prototype.getAbsolutePath = function () { return resolve(this.value); };
  File.prototype.isAbsolute = function () { return paths.isAbsolute(this.value); };
  File.prototype.isFile = function () { return !invalid(this.value) && existing.has(resolve(this.value)); };
  File.prototype.getCanonicalPath = function () {
    canonicalCalls.push(this.value);
    if (invalid(this.value) || inaccessible.has(resolve(this.value))) {
      throw new Error("java.io.IOException: La syntaxe du nom de fichier, de répertoire ou de volume est incorrecte");
    }
    return resolve(this.value);
  };
  const scope = {
    C8O: { agentBridge: {} }
  };
  const namespace = new Proxy(function () {}, {
    get() { return namespace; },
    apply() { throw new Error("Runtime presence detection must not call Java process APIs"); },
    construct() { throw new Error("Runtime presence detection must not start a process"); }
  });
  scope.Packages = namespace;
  vm.createContext(scope);
  vm.runInContext(commonSource, scope, { filename: "js/agent_bridge_common.js" });
  scope.File = File;
  scope.System = {
    getProperty: key => key === "os.name" ? (windows ? "Windows 11" : "Linux") : "",
    getenv: key => key === "PATH" ? systemPath : ""
  };
  return { find: scope.firstExistingCommand, canonicalCalls, scope };
}

test("an installed managed runtime wins without parsing a malformed Windows PATH", () => {
  const command = "C:\\Studio\\agents\\vibe\\.venv\\Scripts\\vibe.exe";
  const search = runtimeSearch({ systemPath: '"C:\\Bad PATH";C:\\broken:entry', files: [command] });
  const result = search.find([command, "vibe"]);
  assert.equal(result.found, true);
  assert.equal(result.path, command);
  assert.deepEqual(search.canonicalCalls, [command]);
});

test("quoted Windows PATH directories preserve spaces and accented characters", () => {
  const command = "C:\\Outils partagés\\Mistral\\vibe.exe";
  const search = runtimeSearch({ systemPath: '"C:\\Outils partagés\\Mistral"', files: [command] });
  assert.equal(search.find(["vibe"]).path, command);
});

test("invalid Windows PATH entries cannot hide a later valid executable", () => {
  const command = "C:\\Tools\\codex.cmd";
  const search = runtimeSearch({ systemPath: 'C:\\bad:entry;"C:\\unclosed;C:\\Tools', files: [command] });
  assert.equal(search.find(["codex"]).path, command);
});

test("an unusable canonical path is skipped without failing provider discovery", () => {
  const denied = "C:\\Unavailable\\python.exe";
  const command = "C:\\Python\\python.exe";
  const search = runtimeSearch({ files: [denied, command], denied: [denied] });
  assert.equal(search.find([denied, command]).path, command);
});

test("explicit commands and extra PATH keep priority and Windows executable extensions", () => {
  const explicit = "C:\\Managed Runtime\\vibe.exe";
  const extra = "C:\\Extra Tools\\vibe.bat";
  const system = "C:\\System Tools\\vibe.exe";
  const search = runtimeSearch({ systemPath: '"C:\\System Tools"', files: [explicit, extra, system] });
  assert.equal(search.find(['"' + explicit + '"', "vibe"], '"C:\\Extra Tools"').path, explicit);
  assert.equal(search.find(["vibe"], '"C:\\Extra Tools"').path, extra);
});

test("a malformed-only PATH returns missing without throwing", () => {
  const search = runtimeSearch({ systemPath: 'C:\\bad:entry;"C:\\unclosed' });
  assert.equal(search.find(["vibe-acp"]).found, false);
});

test("POSIX searches retain literal quotes in directory names", () => {
  const command = '/opt/"tools"/codex';
  const search = runtimeSearch({ windows: false, systemPath: '/opt/"tools":/usr/bin', files: [command] });
  assert.equal(search.find(["codex"]).path, command);
});

test("diagnostics identify a bad PATH position without returning its value", () => {
  const { find, scope } = runtimeSearch({ systemPath: 'C:\\bad:private-value;C:\\Tools', files: ['C:\\Tools\\vibe.exe'] });
  assert.equal(find(['vibe']).found, true);
  assert.equal(scope.runtimePathIssues[0].source, 'path');
  assert.equal(scope.runtimePathIssues[0].index, 1);
  assert.equal(scope.runtimePathIssues[0].code, 'invalid_path');
  assert.doesNotMatch(JSON.stringify(scope.runtimePathIssues), /private-value/);
});

test("Windows registry parsing distinguishes disabled, enabled and unknown", () => {
  const { scope } = runtimeSearch();
  for (const [value, expected] of [['0x0', false], ['0x1', true], ['1', true]]) {
    assert.equal(scope.parseWindowsLongPathsEnabled({ ok: true, stdout: 'LongPathsEnabled    REG_DWORD    ' + value }), expected);
  }
  assert.equal(scope.parseWindowsLongPathsEnabled({ ok: false, stdout: '' }), null);
  assert.equal(scope.parseWindowsLongPathsEnabled({ ok: true, stdout: '' }), null);
});

function filesystemProbe({ longPaths = true, writable = true } = {}) {
  const { scope } = runtimeSearch();
  class LocalPath {
    constructor(value) { this.value = value; }
    resolve(child) { return new LocalPath(path.win32.join(this.value, child)); }
    toString() { return this.value; }
  }
  scope.File.prototype.toPath = function () { return new LocalPath(this.getAbsolutePath()); };
  const created = new Set();
  const check = value => {
    if (!writable || (!longPaths && String(value).length > 260)) throw new Error('Filesystem rejected path');
  };
  scope.Files = {
    createDirectories(value) { check(value); if (String(value).includes('windows-path-check-')) created.add(String(value)); },
    createTempDirectory(root, prefix) { const value = root.resolve(prefix + 'fixture'); check(value); created.add(String(value)); return value; },
    createFile(value) { check(value); created.add(String(value)); },
    deleteIfExists(value) { created.delete(String(value)); }
  };
  return { scope, created };
}

test("long-path probe distinguishes working paths, length failures and write access failures, and cleans up", () => {
  for (const [options, expected] of [[{}, 'supported'], [{ longPaths: false }, 'failed'], [{ writable: false }, 'unknown']]) {
    const { scope, created } = filesystemProbe(options);
    const result = scope.probeWindowsLongPaths('C:\\Studio\\Workspace');
    assert.equal(result.status, expected);
    if (expected !== 'unknown') assert.ok(result.testedLength >= 280);
    assert.equal(created.size, 0);
  }
});

test("presence-only startup never starts registry or filesystem probes; full checks are cached", () => {
  const { scope } = runtimeSearch();
  const values = new Map(); let commands = 0, probes = 0;
  scope.getRuntimeUpdateCache = () => ({ get: key => values.get(key), put: (key, value) => values.set(key, value) });
  scope.hashShort = () => 'workspace'; scope.now = () => 100;
  scope.runCommand = () => { commands++; return { ok: true, stdout: 'LongPathsEnabled REG_DWORD 0x1' }; };
  scope.probeWindowsLongPaths = () => { probes++; return { status: 'supported', testedLength: 282 }; };
  assert.equal(scope.windowsRuntimeDiagnostics({ runtimePresenceOnly: 'true' }, 'C:\\Studio').longPaths.fileSystemProbe, 'not_checked');
  assert.equal(commands, 0); assert.equal(probes, 0);
  assert.equal(scope.windowsRuntimeDiagnostics({}, 'C:\\Studio').longPaths.registryEnabled, true);
  scope.windowsRuntimeDiagnostics({}, 'C:\\Studio');
  scope.windowsRuntimeDiagnostics({ runtimePresenceOnly: 'true' }, 'C:\\Studio');
  assert.equal(commands, 1); assert.equal(probes, 1);
});
