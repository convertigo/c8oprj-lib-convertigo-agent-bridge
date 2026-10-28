// On test-nocode (Linux 5.15, Landlock ABI 1) every No Code user whose Vibe had never run before the sandbox died at
// its first message: Vibe's plugin store publishes its built-in plugin by moving files from plugins/tmp into
// plugins/blobs, and Landlock ABI 1 refuses any move into another directory with EXDEV ("Invalid cross-device link").
// A confined vibe-acp now gets sandbox/python/sitecustomize.py first on PYTHONPATH: on EXDEV, os.rename and os.replace
// copy into the target's directory and rename there, as mv does. Here the kernel's refusal is simulated.
// node --test tests/landlock_moves.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const javaProxy = new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';return javaProxy;},apply(){return javaProxy;},construct(){return javaProxy;}});
global.Packages=javaProxy;global.context=javaProxy;global.C8O={agentBridge:{}};
for(const name of ['common','codex','claude','vibe'])vm.runInThisContext(fs.readFileSync(path.join(root,'js/agent_bridge_'+name+'.js'),'utf8'));
const vibeSource = fs.readFileSync(path.join(root, 'js/agent_bridge_vibe.js'), 'utf8');
const moduleDir = path.join(root, 'sandbox/python');
const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);

class FakeFile {
  constructor(parent, child) { this.p = child === undefined ? String(parent.p || parent) : path.join(String(parent.p || parent), String(child)); }
  getCanonicalPath() { return path.resolve(this.p); }
  isFile() { return fs.existsSync(this.p) && fs.statSync(this.p).isFile(); }
}

function withFakes(fakes, run) {
  const saved = {};
  for (const [name, value] of Object.entries(fakes)) { saved[name] = global[name]; global[name] = value; }
  try { return run(); } finally { for (const [name, value] of Object.entries(saved)) global[name] = value; }
}

test('a confined Python reads the module from the Bridge\'s own folder, none without the project or the module', () => {
  const bridge = dir => withFakes({ File: FakeFile, projectDirectoryByName: name => name === 'lib_ConvertigoAgentBridge' && dir ? new FakeFile(dir) : null }, () => confinedPythonPath());
  assert.equal(bridge(root), moduleDir);
  assert.equal(bridge(null), '');
  assert.equal(bridge(os.tmpdir()), '', 'a Bridge folder without sandbox/python/sitecustomize.py');
});

test('vibeStart puts the module first on the confined process\'s PYTHONPATH and its CPython first on PATH, before the confinement wraps it', () => {
  assert.match(vibeSource, /env\.XDG_CACHE_HOME = noCodeSandbox\.cache;\n\s+if \(noCodeSandbox\.pythonPath\.length\) \{\n\s+env\.PYTHONPATH = noCodeSandbox\.pythonPath \+ \(trim\(env\.PYTHONPATH\)\.length \? String\(File\.pathSeparator\) \+ env\.PYTHONPATH : ""\);\n\s+\}\n\s+if \(noCodeSandbox\.pythonBin\.length\) \{\n\s+env\.PATH = noCodeSandbox\.pythonBin \+ String\(File\.pathSeparator\) \+ \(trim\(env\.PATH\) \|\| String\(System\.getenv\("PATH"\) \|\| ""\)\);\n\s+\}\n\s+command = noCodeSandbox\.wrap\(command\);/);
});

// os.rename and os.replace as Landlock ABI 1 runs them: EXDEV for any move into another directory.
const HARNESS = String.raw`
import errno, json, os, pathlib, stat, sys
real_rename, real_replace = os.rename, os.replace
def kernel(move):
    def moved(src, dst, *, src_dir_fd=None, dst_dir_fd=None):
        if os.path.dirname(os.path.abspath(src)) != os.path.dirname(os.path.abspath(dst)):
            raise OSError(errno.EXDEV, "Invalid cross-device link", src, None, dst)
        return move(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
    return moved
os.rename, os.replace = kernel(real_rename), kernel(real_replace)
# loaded by its path: the Python running the test may have a sitecustomize of its own, imported at startup
import importlib.util
spec = importlib.util.spec_from_file_location("bridge_sitecustomize", os.path.join(sys.argv[1], "sitecustomize.py"))
spec.loader.exec_module(importlib.util.module_from_spec(spec))
work = sys.argv[2]
a, b = os.path.join(work, "a"), os.path.join(work, "b")
os.makedirs(a); os.makedirs(b)
out = {}
def write(file, text):
    with open(file, "w") as handle:
        handle.write(text)
def read(file):
    with open(file) as handle:
        return handle.read()
write(os.path.join(a, "blob"), "bytes"); os.chmod(os.path.join(a, "blob"), 0o400)
os.rename(os.path.join(a, "blob"), os.path.join(b, "blob"))
out["file"] = [read(os.path.join(b, "blob")), oct(stat.S_IMODE(os.stat(os.path.join(b, "blob")).st_mode)), os.path.exists(os.path.join(a, "blob"))]
write(os.path.join(a, "manifest"), "new"); write(os.path.join(b, "manifest"), "old")
os.replace(os.path.join(a, "manifest"), os.path.join(b, "manifest"))
out["replace"] = read(os.path.join(b, "manifest"))
os.makedirs(os.path.join(a, "package", "skills")); write(os.path.join(a, "package", "skills", "SKILL.md"), "skill")
os.chmod(os.path.join(a, "package", "skills"), 0o500)
os.rename(os.path.join(a, "package"), os.path.join(b, "package"))
out["folder"] = [read(os.path.join(b, "package", "skills", "SKILL.md")), os.path.exists(os.path.join(a, "package"))]
write(os.path.join(a, "path"), "p")
pathlib.Path(a, "path").rename(pathlib.Path(b, "path"))
out["pathlib"] = os.path.exists(os.path.join(b, "path"))
os.makedirs(os.path.join(a, "late", "x")); os.makedirs(os.path.join(b, "taken", "y"))
try:
    os.rename(os.path.join(a, "late"), os.path.join(b, "taken")); out["onto_full_folder"] = "moved"
except OSError as error:
    out["onto_full_folder"] = errno.errorcode[error.errno]
out["source_kept"] = os.path.isdir(os.path.join(a, "late", "x"))
try:
    os.rename(os.path.join(a, "missing"), os.path.join(b, "missing")); out["missing"] = "moved"
except OSError as error:
    out["missing"] = errno.errorcode[error.errno]
write(os.path.join(a, "same"), "s")
os.rename(os.path.join(a, "same"), os.path.join(a, "same2"))
out["same_folder"] = os.path.exists(os.path.join(a, "same2"))
out["left"] = sorted(name for name in os.listdir(b) if name.startswith(".c8o-move-"))
print(json.dumps(out))
`;

test('on EXDEV a file, a folder and a replaced file arrive in place; a refused move leaves the source and no copy', { skip: !python && 'no python' }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'landlock-moves-'));
  try {
    const run = spawnSync(python, ['-I', '-c', HARNESS, moduleDir, work], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.deepEqual(out.file, ['bytes', '0o400', false], 'Vibe\'s blob, with its mode, gone from plugins/tmp');
    assert.equal(out.replace, 'new');
    assert.deepEqual(out.folder, ['skill', false], 'a package folder, even one with a read-only folder inside');
    assert.equal(out.pathlib, true, 'Path.rename goes through os.rename');
    assert.ok(['ENOTEMPTY', 'EEXIST'].includes(out.onto_full_folder), out.onto_full_folder);
    assert.equal(out.source_kept, true);
    assert.equal(out.missing, 'ENOENT', 'another error stays what it is');
    assert.equal(out.same_folder, true);
    assert.deepEqual(out.left, [], 'no staged copy left behind');
  } finally {
    spawnSync('chmod', ['-R', 'u+w', work]);
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('Python imports the module by itself when it comes first on PYTHONPATH, and still runs the sitecustomize it hides', { skip: !python && 'no python' }, () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'landlock-moves-site-'));
  try {
    fs.writeFileSync(path.join(other, 'sitecustomize.py'), 'import builtins\nbuiltins.hidden_sitecustomize_ran = True\n');
    const run = spawnSync(python, ['-c', 'import builtins, os, sys; print(sys.modules["sitecustomize"].__file__); print(os.rename.__name__, os.replace.__name__, getattr(builtins, "hidden_sitecustomize_ran", False))'],
      { encoding: 'utf8', env: Object.assign({}, process.env, { PYTHONPATH: moduleDir + path.delimiter + other }) });
    assert.equal(run.status, 0, run.stderr);
    const [file, names] = run.stdout.trim().split('\n');
    assert.equal(path.resolve(file), path.join(moduleDir, 'sitecustomize.py'));
    assert.equal(names, 'rename replace True');
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});
