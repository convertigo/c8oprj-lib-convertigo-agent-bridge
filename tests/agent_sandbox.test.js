// The confinement of the No Code agents moved from the engine (engine.util.AgentSandbox, branch hotfix-optims) to the
// Bridge: the policy agents.tool_policy (the system property wins over the global symbol, the symbol over the property
// of an engine that still has it), the helper of this project (sandbox/linux-<arch>/c8o-agent-sandbox), its probe and
// the command that runs an agent through it, with the same describe() as the engine gave. These checks are those of
// AgentSandboxTest, and what the engine did not do: find the project's helper and give it back its execute bit.
// node --test tests/agent_sandbox.test.js
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

class FakeFile {
  constructor(parent, child) { this.p = child === undefined ? String(parent.p || parent) : path.join(String(parent.p || parent), String(child)); }
  isFile() { return fs.existsSync(this.p) && fs.statSync(this.p).isFile(); }
  isAbsolute() { return path.isAbsolute(this.p); }
  canExecute() { try { fs.accessSync(this.p, fs.constants.X_OK); return true; } catch (e) { return false; } }
  setExecutable() { fs.chmodSync(this.p, 0o700); return true; }
  lastModified() { return fs.statSync(this.p).mtimeMs; }
  getCanonicalPath() { return path.resolve(this.p); }
}

function sandboxWorld(options = {}) {
  const properties = Object.assign({ 'os.name': 'Linux', 'os.arch': 'amd64' }, options.properties || {});
  const probes = [];
  return {
    probes,
    properties,
    fakes: {
      File: FakeFile,
      System: { getProperty: name => properties[name] == null ? null : properties[name], setProperty: (name, value) => { properties[name] = String(value); } },
      ProcessBuilder: class { constructor(args) { this.args = args; } },
      toJavaList: values => values.slice(0),
      // the probe really runs the helper, a script here
      runProcessBuilder: (pb, opts) => {
        probes.push(pb.args.join(' '));
        const run = spawnSync(pb.args[0], pb.args.slice(1), { timeout: opts.timeoutMs, encoding: 'utf8' });
        return { ok: run.status === 0 && !run.error, stdout: run.stdout || '' };
      },
      projectDirectoryByName: name => name === 'lib_ConvertigoAgentBridge' ? options.bridgeDir || null : null,
      log: { warn: () => {} },
      Packages: {
        com: { twinsoft: { convertigo: { engine: {
          Engine: { theApp: { databaseObjectsManager: { symbolsGetValue: name => (options.symbols || {})[name] == null ? null : options.symbols[name] } } },
          EnginePropertiesManager: options.engineProperty === undefined
            ? { PropertyName: { valueOf: () => { throw new Error('No enum constant AGENTS_TOOL_POLICY'); } } }
            : { PropertyName: { valueOf: name => name }, getProperty: () => options.engineProperty }
        } } } }
      }
    }
  };
}

function withWorld(world, run) {
  const saved = {};
  for (const [name, value] of Object.entries(world.fakes)) { saved[name] = global[name]; global[name] = value; }
  try { return run(); } finally { for (const [name, value] of Object.entries(saved)) global[name] = value; }
}

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sandbox-')); }
function script(dir, name, body, executable = true) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\n' + body + '\n');
  fs.chmodSync(file, executable ? 0o700 : 0o600);
  return file;
}

test('auto, nothing or a value no policy has is files; the others are read whatever their case', () => {
  for (const auto of ['auto', '', null, ' AUTO ', 'sandbox']) {
    assert.equal(agentSandboxPolicyName(auto), 'files', String(auto));
  }
  assert.equal(agentSandboxPolicyName('mcp-only'), 'mcp-only');
  assert.equal(agentSandboxPolicyName(' Sandboxed-Shell'), 'sandboxed-shell');
  assert.equal(agentSandboxPolicyName('full'), 'full');
});

test('the system property wins over the global symbol, the symbol over the property of an engine that still has it', () => {
  const policy = options => withWorld(sandboxWorld(options), () => JSON.parse(agentSandbox().describe()).policy);
  assert.equal(policy({}), 'files', 'nothing set: auto');
  assert.equal(policy({ engineProperty: 'mcp-only' }), 'mcp-only', 'an engine of hotfix-optims');
  assert.equal(policy({ engineProperty: 'mcp-only', symbols: { 'agents.tool_policy': 'full' } }), 'full');
  // the platform (the javaOpts of a cloud server) sets the system property: the console's symbol cannot lift it
  assert.equal(policy({ symbols: { 'agents.tool_policy': 'full' }, properties: { 'convertigo.engine.agents.tool_policy': 'sandboxed-shell' } }), 'sandboxed-shell');
});

test('a shell that cannot be confined is files, and its command never runs unconfined', () => {
  const dir = tempDir();
  const world = sandboxWorld({ properties: { 'convertigo.engine.agents.tool_policy': 'sandboxed-shell', 'convertigo.agent.sandbox.helper': path.join(dir, 'missing') } });
  withWorld(world, () => {
    const described = JSON.parse(agentSandbox().describe());
    assert.deepEqual(described, { policy: 'sandboxed-shell', effective: 'files', landlockAbi: 0, helper: path.join(dir, 'missing') });
    assert.throws(() => agentSandbox().wrap(['bash'], [], []), /cannot be confined here/);
  });
  assert.deepEqual(world.probes, [], 'a missing helper is not run');
  const full = sandboxWorld({ properties: { 'convertigo.engine.agents.tool_policy': 'full', 'convertigo.agent.sandbox.helper': path.join(dir, 'missing') } });
  assert.equal(withWorld(full, () => JSON.parse(agentSandbox().describe()).effective), 'full');
});

test('the command runs through the helper with the system read only, each folder once, never /usr/local, /proc or /workspace', () => {
  const args = withWorld(sandboxWorld(), () => buildAgentSandboxCommand('/x/c8o-agent-sandbox', ['vibe-acp', '--x'],
    ['/workspace/agents/vibe/.venv', '/usr/bin'], ['/workspace/agents/vibe/homes/u1', '/workspace/agents/vibe/homes/u1']));
  assert.equal(args[0], '/x/c8o-agent-sandbox');
  const separator = args.indexOf('--');
  assert.deepEqual(args.slice(separator + 1), ['vibe-acp', '--x']);
  const options = args.slice(1, separator);
  for (const system of AGENT_SANDBOX_SYSTEM_READ_ONLY) {
    assert.equal(options[options.indexOf(system) - 1], '--ro', system);
  }
  assert.equal(options[options.indexOf('/workspace/agents/vibe/.venv') - 1], '--ro');
  assert.equal(options[options.indexOf('/workspace/agents/vibe/homes/u1') - 1], '--rw');
  assert.equal(options[options.indexOf('/dev/null') - 1], '--rw');
  assert.equal(options.filter(o => o === '/workspace/agents/vibe/homes/u1').length, 1, 'a path given twice is passed once');
  assert.equal(options.filter(o => o === '/usr/bin').length, 1);
  assert.ok(!options.includes('/usr/local') && !options.includes('/usr'), 'not Tomcat nor the engine');
  // of /proc, its own entries and the system-wide files: not the command lines of the other processes
  assert.ok(!options.includes('/proc'));
  assert.equal(options[options.indexOf('/proc/self') - 1], '--ro');
  assert.ok(!options.includes('/workspace'));
  // the same system list as engine.util.AgentSandbox.SYSTEM_READ_ONLY after 589dcd967, and as the helper's checks
  const checks = fs.readFileSync(path.join(root, 'sandbox/c8o-agent-sandbox-test.sh'), 'utf8');
  assert.ok(checks.includes('for p in ' + AGENT_SANDBOX_SYSTEM_READ_ONLY.join(' ') + ';'), 'the checks test the list the Bridge gives');
});

test('a relative path, a NUL or no command is refused', () => {
  withWorld(sandboxWorld(), () => {
    assert.throws(() => buildAgentSandboxCommand('h', ['bash'], ['workspace'], []), /Not an absolute path/);
    assert.throws(() => buildAgentSandboxCommand('h', ['bash'], [], [null]), /Not an absolute path/);
    assert.throws(() => buildAgentSandboxCommand('h', ['bash'], ['/a\u0000b'], []), /Not an absolute path/);
    assert.throws(() => buildAgentSandboxCommand('h', [], [], []), /No command to confine/);
  });
});

test('the probe takes the Landlock version on success only', () => {
  const dir = tempDir();
  withWorld(sandboxWorld(), () => {
    assert.equal(probeAgentSandbox(script(dir, 'ok', '[ "$1" = --probe ] && echo 3'), 5000), 3);
    assert.equal(probeAgentSandbox(script(dir, 'none', 'echo 0; exit 3'), 5000), 0);
    assert.equal(probeAgentSandbox(script(dir, 'failed', 'echo 2; exit 1'), 5000), 0);
    assert.equal(probeAgentSandbox(script(dir, 'text', 'echo landlock'), 5000), 0);
    assert.equal(probeAgentSandbox(script(dir, 'slow', 'sleep 5; echo 1'), 300), 0);
    assert.equal(probeAgentSandbox(script(dir, 'plain', 'echo 1', false), 5000), 0, 'not executable');
    assert.equal(probeAgentSandbox(path.join(dir, 'missing'), 5000), 0);
  });
});

test('the helper of this project is taken for this machine and made executable; the system property names another one', () => {
  const bridge = tempDir();
  for (const arch of ['linux-amd64', 'linux-arm64']) {
    fs.mkdirSync(path.join(bridge, 'sandbox', arch), { recursive: true });
    // a .car or a checkout can lose the execute bit
    script(path.join(bridge, 'sandbox', arch), 'c8o-agent-sandbox', 'echo 1', false);
  }
  const helper = (properties) => withWorld(sandboxWorld({ bridgeDir: bridge, properties }), () => agentSandboxHelper());
  assert.equal(helper({}), path.join(bridge, 'sandbox/linux-amd64/c8o-agent-sandbox'));
  assert.ok(new FakeFile(path.join(bridge, 'sandbox/linux-amd64/c8o-agent-sandbox')).canExecute(), 'its execute bit is back');
  assert.equal(helper({ 'os.arch': 'aarch64' }), path.join(bridge, 'sandbox/linux-arm64/c8o-agent-sandbox'));
  assert.equal(helper({ 'os.arch': 'x86_64' }), path.join(bridge, 'sandbox/linux-amd64/c8o-agent-sandbox'));
  assert.equal(helper({ 'os.arch': 'ppc64le' }), '/usr/local/bin/c8o-agent-sandbox', 'no helper for this machine: the one of an image');
  assert.equal(helper({ 'convertigo.agent.sandbox.helper': '/opt/other' }), '/opt/other');
  assert.equal(withWorld(sandboxWorld({}), () => agentSandboxHelper()), '/usr/local/bin/c8o-agent-sandbox', 'no project folder');
  // the project carries one binary per architecture, built by the CI from its source
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/sandbox-helper.yml'), 'utf8');
  assert.match(workflow, /gcc -O2 -Wall -Wextra -Werror -static -o build\/linux-\$\{\{ matrix\.arch \}\}\/c8o-agent-sandbox sandbox\/c8o-agent-sandbox\.c/);
  assert.match(workflow, /arch: amd64\n\s+runner: ubuntu-24\.04\n\s+- arch: arm64\n\s+runner: ubuntu-24\.04-arm/);
});

test('describe() gives what the engine gave, the probe runs once per helper, nothing is confined off Linux', () => {
  const dir = tempDir();
  const helperPath = script(dir, 'c8o-agent-sandbox', '[ "$1" = --probe ] && echo 1');
  const world = sandboxWorld({ properties: { 'convertigo.engine.agents.tool_policy': 'sandboxed-shell', 'convertigo.agent.sandbox.helper': helperPath } });
  withWorld(world, () => {
    assert.deepEqual(JSON.parse(agentSandbox().describe()), { policy: 'sandboxed-shell', effective: 'sandboxed-shell', landlockAbi: 1, helper: helperPath });
    const wrapped = agentSandbox().wrap(['vibe-acp'], ['/venv'], ['/home']);
    assert.equal(wrapped[0], helperPath);
    assert.deepEqual(wrapped.slice(-4), ['--rw', '/home', '--', 'vibe-acp']);
    agentSandbox().describe();
  });
  assert.equal(world.probes.length, 1, 'probed once, then read from the engine-wide cache');
  const mac = sandboxWorld({ properties: { 'os.name': 'Mac OS X', 'convertigo.engine.agents.tool_policy': 'sandboxed-shell', 'convertigo.agent.sandbox.helper': helperPath } });
  assert.deepEqual(withWorld(mac, () => JSON.parse(agentSandbox().describe())), { policy: 'sandboxed-shell', effective: 'files', landlockAbi: 0, helper: helperPath });
  assert.equal(mac.probes.length, 0);
});

test('the No Code sessions read agentSandbox(); the engine class is no longer called', () => {
  const common = fs.readFileSync(path.join(root, 'js/agent_bridge_common.js'), 'utf8');
  assert.doesNotMatch(common, /engine\.util\.AgentSandbox\b(?!\.describe\(\) gave)(?! of the engine)/, 'only named in comments about its origin');
  assert.match(common, /var described = JSON\.parse\(String\(agentSandbox\(\)\.describe\(\)\)\);/);
  assert.match(common, /return agentSandbox\(\)\.wrap\(command, this\.readOnly, this\.readWrite\);/);
});
