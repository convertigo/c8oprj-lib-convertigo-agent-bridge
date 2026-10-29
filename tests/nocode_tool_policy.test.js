// A No Code session works through the Convertigo MCP, with what the engine's agents.tool_policy allows besides
// (engine.util.AgentSandbox; files on an engine without it). On test-nocode a Mistral Large 4 agent ran `bash: jq ...`
// in the engine container: Vibe offered its shell, file and web tools and the Bridge approved every permission.
// mcp-only and files remove the shell, the session works in its own folder, and the Bridge refuses a permission for
// a tool that is not a Convertigo MCP one; sandboxed-shell runs vibe-acp through the engine's Landlock helper.
// The Studio's own session (user studio) is never limited.
// node --test tests/nocode_tool_policy.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const javaProxy = new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';return javaProxy;},apply(){return javaProxy;},construct(){return javaProxy;}});
global.Packages=javaProxy;global.context=javaProxy;global.C8O={agentBridge:{}};
for(const name of ['common','codex','claude','vibe'])vm.runInThisContext(fs.readFileSync(path.join(root,'js/agent_bridge_'+name+'.js'),'utf8'));
const vibeSource = fs.readFileSync(path.join(root, 'js/agent_bridge_vibe.js'), 'utf8');
const noCode = { userId: 'person@example.invalid', conversationId: 'agent-1' };
const studio = { userId: 'studio' };

// java.io.File for the paths, and an engine whose agents.tool_policy is `policy` (undefined: an older engine)
class FakeFile {
  constructor(parent, child) { this.p = child === undefined ? String(parent) : path.join(String(parent), String(child)); }
  getCanonicalPath() { return path.resolve(this.p); }
  getParentFile() { return new FakeFile(path.dirname(this.p)); }
}
FakeFile.pathSeparator = ':';
function withEngine(policy, run, extra = {}) {
  const saved = {};
  const wrapped = [];
  const fakes = {
    File: FakeFile,
    ensureDirectory: () => {},
    toJavaList: values => values.slice(0),
    readTextFile: file => { if (extra.pyvenv && /pyvenv\.cfg$/.test(file.p)) return extra.pyvenv; throw new Error('no file'); },
    nodeRuntimeSearchPath: () => extra.nodePath || '',
    confinedPythonPath: () => extra.pythonPath || '',
    stableId: (prefix, value) => prefix + '-' + value,
    agentSandbox: () => policy === undefined ? { describe: () => { throw new Error('no sandbox'); } } : {
      describe: () => JSON.stringify({ policy: extra.configured || policy, effective: policy, landlockAbi: extra.abi === undefined ? 1 : extra.abi, helper: '/usr/local/bin/c8o-agent-sandbox' }),
      wrap: (command, ro, rw) => { wrapped.push({ command, ro, rw }); return ['/usr/local/bin/c8o-agent-sandbox', '--', ...command]; }
    }
  };
  for (const [name, value] of Object.entries(fakes)) { saved[name] = global[name]; global[name] = value; }
  try { return run(wrapped); } finally { for (const [name, value] of Object.entries(saved)) global[name] = value; }
}

function writtenConfig(options) {
  let text = null;
  const saved = global.writeTextFile;
  global.writeTextFile = (_file, value) => { text = value; };
  try {
    writeLocalVibeConfig('/tmp/vibe-home', 'http://localhost:18080/convertigo/api/mcp', 'mistral-large-4', options);
  } finally {
    global.writeTextFile = saved;
  }
  return text;
}

function topLevel(text) {
  const lines = text.split('\n');
  return lines.slice(0, lines.indexOf('[[providers]]'));
}

test('a No Code session takes the effective policy of its engine, files on an engine without it; a Studio session none', () => {
  assert.equal(withEngine(undefined, () => noCodeToolPolicyName(noCode)), 'files');
  for (const policy of ['mcp-only', 'files', 'sandboxed-shell', 'full']) {
    assert.equal(withEngine(policy, () => noCodeToolPolicyName(noCode)), policy);
    assert.equal(withEngine(policy, () => vibeToolPolicy(noCode)), 'nocode-' + policy + (policy === 'full' ? '' : '-landlock') + '-v4');
    assert.equal(withEngine(policy, () => vibeToolPolicy(noCode), { abi: 0 }), 'nocode-' + policy + '-v4', 'an engine that cannot confine');
    assert.equal(withEngine(policy, () => noCodeToolPolicyName(studio)), '', 'the Studio session is never limited');
    assert.equal(withEngine(policy, () => vibeToolPolicy(studio)), '');
  }
  assert.equal(withEngine('anything', () => noCodeToolPolicyName(noCode)), 'files');
});

test('each policy writes what its config.toml leaves out, before the first table', () => {
  const mcpOnly = withEngine('mcp-only', () => topLevel(writtenConfig(noCode)));
  assert.ok(mcpOnly.includes('disabled_tools = ["bash*", "git_bash*", "powershell*", "grep", "web_fetch", "web_search", "task", "read_file", "write_file", "edit"]'), mcpOnly.join('\n'));
  assert.ok(mcpOnly.includes('enable_background_processes = false') && mcpOnly.includes('enable_subagents = false'));

  const filesText = withEngine('files', () => writtenConfig(noCode));
  const files = topLevel(filesText);
  assert.ok(files.includes('disabled_tools = ["bash*", "git_bash*", "powershell*", "grep", "web_fetch", "web_search", "task"]'), files.join('\n'));
  assert.ok(files.includes('enable_background_processes = false'));
  // writes in the session's folder need no permission; outside it Vibe asks and the Bridge refuses
  assert.match(filesText, /\n\[tools\.write_file\]\npermission = "always"\n\n\[tools\.edit\]\npermission = "always"\n/);
  // a tool result Vibe saved to a file lies in VIBE_HOME, outside the session's folder: read_file reads it without asking
  assert.match(filesText, /\n\[tools\.read_file\]\nallowlist = \["\/tmp\/vibe-home\/logs\/session\/unified\/\*\/tool-results\/\*"\]\n/);

  const shell = withEngine('sandboxed-shell', () => topLevel(writtenConfig(noCode)));
  assert.ok(shell.includes('disabled_tools = ["grep", "web_fetch", "web_search", "task"]'), shell.join('\n'));
  // background processes would bring Vibe's `wait` builtin, which waits for input the Tigo panel never sends mid-turn
  assert.ok(shell.includes('enable_background_processes = false') && shell.includes('enable_subagents = false'), shell.join('\n'));

  for (const [policy, options] of [['full', noCode], ['files', studio]]) {
    const text = withEngine(policy, () => writtenConfig(options));
    assert.doesNotMatch(text, /disabled_tools|enable_background_processes|enable_subagents|\[tools\./, policy + ' ' + options.userId);
  }
});

test('a No Code session works in its own folder; where the engine confines, vibe-acp runs confined to its runtime, its home and that folder', () => {
  const home = '/workspace/agents/vibe/homes-convertigo/users/person/.vibe-home';
  const files = withEngine('files', () => noCodeSessionSandbox(noCode, { installDir: '/workspace/agents/vibe' }, home), { abi: 0 });
  assert.equal(files.cwd, '/workspace/agents/vibe/homes-convertigo/users/person/scratch/conversation-agent-1');
  assert.equal(files.tmp, files.cwd + '/.tmp');
  assert.equal(files.confined, false, 'an engine that cannot confine');
  assert.equal(files.pythonBin, '', 'nothing added to an unconfined PATH');
  assert.deepEqual(files.readWrite, [home, files.cwd]);
  assert.deepEqual([files.home, files.cache], [files.cwd, files.cwd + '/.cache']);
  assert.notEqual(withEngine('files', () => noCodeSessionSandbox({ ...noCode, conversationId: 'agent-2' }, {}, home)).cwd, files.cwd, 'one folder per conversation');
  for (const policy of ['mcp-only', 'files', 'sandboxed-shell']) {
    assert.equal(withEngine(policy, () => noCodeSessionSandbox(noCode, {}, home)).confined, true, policy + ' where the engine confines');
  }

  withEngine('sandboxed-shell', wrapped => {
    const shell = noCodeSessionSandbox(noCode, { installDir: '/workspace/agents/vibe' }, home);
    assert.equal(shell.confined, true);
    // the venv, not the install folder that holds every user's VIBE_HOME; the Bridge's module for Landlock ABI 1 moves
    assert.deepEqual(shell.readOnly, ['/workspace/agents/vibe/.venv', '/workspace/agents/python/cpython-3.12', '/workspace/nodes/node-v22/bin', '/workspace/nodes/node-v22', '/workspace/projects/lib_ConvertigoAgentBridge/sandbox/python']);
    assert.equal(shell.pythonPath, '/workspace/projects/lib_ConvertigoAgentBridge/sandbox/python');
    assert.equal(shell.pythonBin, '/workspace/agents/python/cpython-3.12/bin', 'python3 for the shell, from the runtime it already reads');
    assert.deepEqual(shell.wrap(['vibe-acp']), ['/usr/local/bin/c8o-agent-sandbox', '--', 'vibe-acp']);
    assert.deepEqual(wrapped[0], { command: ['vibe-acp'], ro: shell.readOnly, rw: [home, shell.cwd] });
  }, { pyvenv: 'home = /workspace/agents/python/cpython-3.12/bin\nversion = 3.12.8\n', nodePath: '/workspace/nodes/node-v22/bin:/workspace/nodes/node-v22', pythonPath: '/workspace/projects/lib_ConvertigoAgentBridge/sandbox/python' });

  assert.equal(withEngine('full', () => noCodeSessionSandbox(noCode, {}, home)), null);
  assert.equal(withEngine('files', () => noCodeSessionSandbox(studio, {}, home)), null);
});

test('the status of a session says what it may do: the policy its harness applies, its confinement, never limited in the Studio', () => {
  const home = '/workspace/agents/vibe/homes-convertigo/users/person/.vibe-home';
  const vibe = (policy, extra) => withEngine(policy, () => agentSessionSandbox(noCode, 'vibe', noCodeSessionSandbox(noCode, {}, home)), extra);
  assert.deepEqual(vibe('files'), { scope: 'nocode', policy: 'files', source: 'engine', configured: '', confined: true, landlockAbi: 1 });
  assert.deepEqual(vibe('mcp-only', { abi: 6 }), { scope: 'nocode', policy: 'mcp-only', source: 'engine', configured: '', confined: true, landlockAbi: 6 });
  assert.deepEqual(vibe('files', { abi: 0 }), { scope: 'nocode', policy: 'files', source: 'engine', configured: '', confined: false, landlockAbi: 0 }, 'an engine that cannot confine');
  assert.deepEqual(vibe('files', { abi: 0, configured: 'sandboxed-shell' }), { scope: 'nocode', policy: 'files', source: 'engine', configured: 'sandboxed-shell', confined: false, landlockAbi: 0 }, 'the shell asked where the engine cannot confine it');
  assert.deepEqual(vibe('full'), { scope: 'nocode', policy: 'full', source: 'engine', configured: '', confined: false, landlockAbi: 1 });
  assert.deepEqual(withEngine(undefined, () => agentSessionSandbox(noCode, 'vibe', null)), { scope: 'nocode', policy: 'files', source: 'engine', configured: '', confined: false, landlockAbi: 0 }, 'an engine older than agents.tool_policy');
  for (const provider of ['codex', 'claude']) {
    assert.deepEqual(withEngine('mcp-only', () => agentSessionSandbox(noCode, provider, null)), { scope: 'nocode', policy: 'full', source: 'harness', configured: '', confined: false, landlockAbi: 1 }, provider + ' does not apply the policy');
  }
  for (const provider of ['vibe', 'codex', 'claude']) {
    assert.deepEqual(withEngine('mcp-only', () => agentSessionSandbox(studio, provider, null)), { scope: 'studio', policy: 'full', source: 'studio', configured: '', confined: false, landlockAbi: 0 });
  }
  const savedAlive = global.processAlive;
  global.processAlive = () => true;
  try {
    const entry = createEntry('h', 'vibe', 'acp', [], '/tmp', {}, 1000, null, null, '');
    assert.equal(statusOf(entry).sandbox, null, 'a session started by an older Bridge');
    entry.sandbox = vibe('files');
    assert.deepEqual(statusOf(entry).sandbox, entry.sandbox);
  } finally {
    global.processAlive = savedAlive;
  }
  for (const [source, provider] of [[vibeSource, 'vibe'], ...['codex', 'claude'].map(name => [fs.readFileSync(path.join(root, 'js/agent_bridge_' + name + '.js'), 'utf8'), name])]) {
    assert.ok(source.includes('entry.sandbox = agentSessionSandbox(options, "' + provider + '", ' + (provider === 'vibe' ? 'noCodeSandbox' : 'null') + ');'), provider);
  }
});

test('vibeStart puts the session in its folder, confines its command and fails rather than run it unconfined', () => {
  const start = vibeSource.slice(vibeSource.indexOf('var noCodeSandbox = null;'), vibeSource.indexOf('var ttlMillis = '));
  assert.match(start, /cwd = noCodeSandbox\.cwd;\n\s+env\.TMPDIR = noCodeSandbox\.tmp;/);
  assert.match(start, /if \(noCodeSandbox\.confined\) \{\n\s+env\.HOME = noCodeSandbox\.home;\n\s+env\.XDG_CACHE_HOME = noCodeSandbox\.cache;\n[\s\S]{0,600}?\n\s+command = noCodeSandbox\.wrap\(command\);/);
  assert.match(start, /catch \(sandboxError\) \{\n\s+return \{ ok: false, status: "error", phase: "sandbox"/);
  assert.match(vibeSource, /entry\.noCodePolicy = noCodeSandbox !== null \? noCodeSandbox\.policy : noCodeToolPolicyName\(options\);/);
});

test('a No Code home records its tool policy in the config intent, so an existing home is rewritten when it changes', () => {
  assert.match(vibeSource, /var expectedToolPolicy = vibeToolPolicy\(options\);\n\s+if \(expectedToolPolicy\.length\) \{\n\s+intentFields\.toolPolicy = expectedToolPolicy;/);
  assert.match(vibeSource, /var expectedIntent = vibeConfigIntent\(intentFields\);/);
});

test('a resident process started under another tool policy restarts on the same session', () => {
  assert.match(vibeSource, /var toolPolicyChanged = trim\(existing\.toolPolicy\) !== vibeToolPolicy\(options\);/);
  const branch = vibeSource.slice(vibeSource.indexOf('} else if (toolPolicyChanged) {'), vibeSource.indexOf('} else if (catalogChanged) {'));
  assert.match(branch, /options\.sessionId = trim\(existing\.sessionId\);/);
  assert.match(branch, /reason: "tool_policy_changed"/);
  assert.match(branch, /stopEntry\(existing, true\);\n\s+existing = null;/);
  assert.match(vibeSource, /entry\.toolPolicy = vibeToolPolicy\(options\);/);
});

function permissionAnswers(entry, toolCall) {
  const answers = [];
  const events = [];
  const saved = [global.sendJsonResponse, global.pushEvent];
  global.sendJsonResponse = (_entry, id, result) => { answers.push({ id, result }); };
  global.pushEvent = (_entry, type, data) => { events.push({ type, data }); };
  try {
    handleAgentRequest(entry, { id: 7, method: 'session/request_permission', params: { toolCall, options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }
    ] } });
  } finally {
    [global.sendJsonResponse, global.pushEvent] = saved;
  }
  return { outcome: answers[0].result.outcome, events };
}

const allowed = { outcome: 'selected', optionId: 'allow_once' };
const refused = { outcome: 'selected', optionId: 'reject_once' };

test('under mcp-only and files the session refuses a permission for a tool that is not a Convertigo MCP one', () => {
  for (const policy of ['mcp-only', 'files']) {
    const entry = { noCodePolicy: policy };
    const savedPush = global.pushEvent;
    global.pushEvent = () => {};
    try {
      // Titles as the run of test-nocode shows them, the tool_call update before the permission request.
      normalizeSessionUpdate(entry, { update: { sessionUpdate: 'tool_call', toolCallId: 'effect-5675b7de', title: 'bash: jq -r .workspaces[] /workspace/agents/vibe/x.json', status: 'pending' } });
      normalizeSessionUpdate(entry, { update: { sessionUpdate: 'tool_call', toolCallId: 'effect-39886a25', title: 'mcp_Convertigo.nocode_baserow_catalog_list', status: 'pending' } });
      normalizeSessionUpdate(entry, { update: { sessionUpdate: 'tool_call', toolCallId: 'effect-77', title: 'read_file: /workspace/agents/nocode/users/other/token', status: 'pending' } });
    } finally {
      global.pushEvent = savedPush;
    }
    const shell = permissionAnswers(entry, { toolCallId: 'effect-5675b7de' });
    assert.deepEqual(shell.outcome, refused, policy);
    const event = shell.events.find(e => e.type === 'permission/refused');
    assert.deepEqual([event.data.reason, event.data.title], ['nocode_tool_policy', 'bash: jq -r .workspaces[] /workspace/agents/vibe/x.json']);
    assert.deepEqual(permissionAnswers(entry, { toolCallId: 'effect-77' }).outcome, refused, policy + ': a read outside the folder asks, and is refused');
    assert.deepEqual(permissionAnswers(entry, { toolCallId: 'effect-39886a25' }).outcome, allowed, policy);
    assert.deepEqual(permissionAnswers(entry, { toolCallId: 'Convertigo_nocode-form-get' }).outcome, allowed, policy + ': a direct MCP call');
    assert.deepEqual(permissionAnswers(entry, { toolCallId: 'file_system.bash' }).outcome, refused, policy + ': an id Vibe built from the tool name');
    assert.deepEqual(permissionAnswers(entry, { toolCallId: 'effect-unknown' }).outcome, allowed, policy + ': a call never seen is left to the config');
  }
});

test('under sandboxed-shell and full, and in a Studio session, the permissions are approved as before', () => {
  for (const entry of [{ noCodePolicy: 'sandboxed-shell' }, { noCodePolicy: 'full' }, { noCodePolicy: '' }, {}]) {
    assert.deepEqual(permissionAnswers(entry, { toolCallId: 'file_system.bash', title: 'bash: npm test' }).outcome, allowed, JSON.stringify(entry));
  }
});

test('the remembered tool titles stay bounded', () => {
  const entry = {};
  for (let i = 0; i < 250; i++) rememberToolCallTitle(entry, 'effect-' + i, 'mcp_Convertigo.tool_' + i);
  assert.equal(Object.keys(entry.toolCallTitles).length, 200);
  assert.equal(entry.toolCallTitles['effect-0'], undefined);
  assert.equal(entry.toolCallTitles['effect-249'], 'mcp_Convertigo.tool_249');
});
