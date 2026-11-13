// A Mistral Large 4 turn through Vibe wrote its payloads at the workspace root (`workspace/_mcp_payloads/app_js.txt`),
// the working directory of a Studio session. Each conversation now has its temporary folder under its working
// directory: <cwd>/.agent-tmp/<conversation>, or <folder>/.agent-tmp for a No Code Vibe session, whose folder belongs
// to its conversation alone and is the one a confined session writes. The Bridge creates it when it starts the
// conversation's process, names it at the start of each turn of the three runtimes, and the instructions say to write
// temporary files there, never at the workspace or project root.
// node --test tests/agent_temp_dir.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const javaProxy = new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';return javaProxy;},apply(){return javaProxy;},construct(){return javaProxy;}});
global.Packages=javaProxy;global.context=javaProxy;global.request=javaProxy;global.log=javaProxy;global.C8O={agentBridge:{}};
for(const name of ['common','codex','vibe','claude'])vm.runInThisContext(fs.readFileSync(path.join(root,'js/agent_bridge_'+name+'.js'),'utf8'),{filename:'agent_bridge_'+name+'.js'});
const source = (name) => fs.readFileSync(path.join(root, 'js/agent_bridge_' + name + '.js'), 'utf8');

class FakeFile {
  constructor(parent, child) { this.p = child === undefined ? String(parent) : path.join(String(parent && parent.p ? parent.p : parent), String(child)); }
  getCanonicalPath() { return path.resolve(this.p); }
  getParentFile() { return new FakeFile(path.dirname(this.p)); }
}

// java.io.File, readable conversation folder names, and the folders the Bridge creates
function withFolders(run, ensure) {
  const created = [];
  const fakes = {
    File: FakeFile,
    stableId: (prefix, value) => prefix + '-' + value,
    ensureDirectory: ensure || ((file) => { created.push(file.p); })
  };
  const saved = {};
  for (const [name, value] of Object.entries(fakes)) { saved[name] = global[name]; global[name] = value; }
  try { return run(created); } finally { for (const [name, value] of Object.entries(saved)) global[name] = value; }
}

test('one folder per conversation under the working directory', () => {
  withFolders(() => {
    assert.equal(agentTempDir('/ws', 'conv-1', false), '/ws/.agent-tmp/conversation-conv-1');
    assert.notEqual(agentTempDir('/ws', 'conv-2', false), agentTempDir('/ws', 'conv-1', false));
    // a working directory that belongs to the conversation alone (No Code Vibe session folder)
    assert.equal(agentTempDir('/home/scratch/conversation-conv-1', 'conv-1', true), '/home/scratch/conversation-conv-1/.agent-tmp');
    assert.equal(agentTempDir('', 'conv-1', false), '', 'no working directory, no folder');
    assert.equal(agentTempDir('/ws', '', false), '/ws/.agent-tmp/conversation-session');
  });
});

test('the Bridge creates it when it starts the conversation, but for a settings probe', () => {
  withFolders((created) => {
    const entry = { cwd: '/ws' };
    assert.equal(prepareAgentTempDir(entry, 'conv-1', {}, false), '/ws/.agent-tmp/conversation-conv-1');
    assert.equal(entry.agentTempDir, '/ws/.agent-tmp/conversation-conv-1');
    assert.deepEqual(created, ['/ws/.agent-tmp/conversation-conv-1']);
    const probe = { cwd: '/ws' };
    prepareAgentTempDir(probe, 'conv-2', { settingsProbe: 'true' }, false);
    assert.equal(probe.agentTempDir, '/ws/.agent-tmp/conversation-conv-2');
    assert.equal(created.length, 1, 'a settings probe never gets a turn');
  });
  // a folder that cannot be created does not stop the start; the turn creates it again
  withFolders(() => {
    const entry = { cwd: '/ws' };
    assert.equal(prepareAgentTempDir(entry, 'conv-1', {}, false), '/ws/.agent-tmp/conversation-conv-1');
  }, () => { throw new Error('read-only'); });
});

test('a No Code Vibe session writes its folder inside the session folder its sandbox allows', () => {
  const home = '/workspace/agents/vibe/homes-convertigo/users/person/.vibe-home';
  const noCode = { userId: 'person@example.invalid', conversationId: 'agent-1' };
  withFolders(() => {
    // an engine that confines its No Code agents under the files policy
    const fakes = {
      agentSandbox: () => ({ describe: () => JSON.stringify({ policy: 'files', effective: 'files', landlockAbi: 1, helper: '/h' }), wrap: (command) => command }),
      confinedPythonPath: () => '',
      nodeRuntimeSearchPath: () => '',
      readTextFile: () => { throw new Error('no file'); }
    };
    const saved = {};
    for (const [name, value] of Object.entries(fakes)) { saved[name] = global[name]; global[name] = value; }
    try {
      const sandbox = noCodeSessionSandbox(noCode, {}, home);
      assert.equal(sandbox.confined, true);
      const dir = agentTempDir(sandbox.cwd, noCode.conversationId, true);
      assert.equal(dir, sandbox.cwd + '/.agent-tmp');
      assert.ok(sandbox.readWrite.includes(sandbox.cwd) && dir.startsWith(sandbox.cwd + '/'), 'inside the folder the confined session writes');
    } finally {
      for (const [name, value] of Object.entries(saved)) global[name] = value;
    }
  });
});

test('each turn names the folder, created again if it went away', () => {
  withFolders((created) => {
    const turn = withAgentTempDirPrompt('Build the app', '/ws/.agent-tmp/conversation-conv-1');
    assert.equal(turn, 'Temporary folder of this conversation: `/ws/.agent-tmp/conversation-conv-1` (write temporary files there: payloads, scripts, notes; never at the workspace or project root).\n\nBuild the app');
    assert.deepEqual(created, ['/ws/.agent-tmp/conversation-conv-1']);
    assert.equal(withAgentTempDirPrompt(turn, '/ws/.agent-tmp/conversation-conv-1'), turn, 'once per prompt');
    assert.equal(withAgentTempDirPrompt('Build the app', ''), 'Build the app', 'an entry started before the folder existed');
    assert.equal(withAgentTempDirPrompt('Build the app', undefined), 'Build the app');
  });
  withFolders(() => {
    assert.equal(withAgentTempDirPrompt('Build the app', '/ro/.agent-tmp/x'), 'Build the app', 'a folder that cannot be created is not named');
  }, () => { throw new Error('read-only'); });
});

test('the three runtimes prepare the folder at start and name it on each turn', () => {
  const codex = source('codex');
  const vibe = source('vibe');
  const claude = source('claude');
  assert.match(codex, /entry\.conversationId = [^\n]+\n\s*prepareAgentTempDir\(entry, entry\.conversationId \|\| handle, options, false\);/);
  assert.match(claude, /entry\.conversationId = [^\n]+\n\s*prepareAgentTempDir\(entry, entry\.conversationId \|\| handle, options, false\);/);
  assert.match(vibe, /prepareAgentTempDir\(entry, trim\(options\.conversationId\) \|\| handle, options, noCodeSandbox !== null\);\n\s*registry\.put\(handle, entry\);/);
  // both Codex turn paths (app-server and exec), the Vibe turn, and the provider runtime turn that is not a menu command
  assert.equal((codex.match(/promptText = withAgentTempDirPrompt\(promptText, entry\.agentTempDir\);\n\s*promptText = withRevealModePrompt/g) || []).length, 2);
  assert.equal((vibe.match(/promptText = withAgentTempDirPrompt\(promptText, entry\.agentTempDir\);\n\s*promptText = withRevealModePrompt/g) || []).length, 1);
  assert.match(claude, /\} else \{\n\s*promptText = withAgentTempDirPrompt\(promptText, entry\.agentTempDir\);\n\s*promptText = withRevealModePrompt/);
});

test('the instructions of every runtime and profile say where temporary files go', () => {
  const savedFlow = global.flowCapabilityAvailable;
  global.flowCapabilityAvailable = () => true;
  try {
    const rule = 'When you need a temporary file (a payload, a script, a note), write it in the temporary folder of this conversation, which each turn names (`Temporary folder of this conversation: <path>`), never at the workspace or project root.';
    const texts = {
      'codex': agentSkillInstructions('codex', ''),
      'vibe': agentSkillInstructions('vibe', 'generalist'),
      'codex flow': agentSkillInstructions('codex', 'flow'),
      'codex nocode': agentSkillInstructions('codex', 'nocode'),
      'vibe nocode': agentSkillInstructions('vibe', 'nocode'),
      'provider runtime': claudeInstructions({ cwd: '/w' }, 'generalist'),
      'provider runtime nocode': claudeInstructions({ cwd: '/w' }, 'nocode'),
      'provider runtime flow': claudeFlowInstructions({ cwd: '/w' }),
      'vibe flow-only home': vibeFlowFacadeAgents('http://localhost:18080/convertigo/api/flow-mcp')
    };
    for (const [label, text] of Object.entries(texts)) {
      assert.ok(text.includes(rule), label);
      assert.equal(text.split(rule).length, 2, label + ': once');
      assert.doesNotMatch(text, /_mcp_payloads|\.agent-tmp/, label + ': no folder of a given conversation in a shared home');
    }
  } finally {
    global.flowCapabilityAvailable = savedFlow;
  }
});
