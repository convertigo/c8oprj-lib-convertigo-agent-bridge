// "Lecture seule" of the Tigo panel in a Studio: the MCP refuses every write of the agent's managed token, but the
// agent's own file and shell tools never reach the MCP. While the Studio is read only ("user:studio" of
// lib_ConvertigoAssistant.writeConfirm in context.server, mode readonly), its conversations run without them: Codex in
// its read-only sandbox for each turn, the provider runtime with --disallowedTools (restart on a change), Vibe with the
// disabled_tools of its config.toml (restart on a change, through toolPolicy). No Code sessions are never concerned.
// node --test tests/studio_read_only_tools.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const javaProxy = new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';if(p==='isFile'||p==='isDirectory'||p==='exists')return ()=>false;return javaProxy;},apply(){return javaProxy;},construct(){return javaProxy;}});
global.Packages=javaProxy;global.context=javaProxy;global.request=javaProxy;global.log=javaProxy;global.C8O={agentBridge:{}};
for(const name of ['common','codex','vibe','claude'])vm.runInThisContext(fs.readFileSync(path.join(root,'js/agent_bridge_'+name+'.js'),'utf8'),{filename:'agent_bridge_'+name+'.js'});
const source = (name) => fs.readFileSync(path.join(root, 'js/agent_bridge_' + name + '.js'), 'utf8');

const studio = { userId: 'studio', conversationId: 'agent-1' };
const noCode = { userId: 'person@example.invalid', conversationId: 'agent-2' };
const READ_ONLY_TOOLS = ['Bash', 'PowerShell', 'Monitor', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'EnterWorktree'];

// context.server as the engine shares it: lib_ConvertigoAssistant.writeConfirm is a map of JSON strings
function serverWith(choices) {
  const map = new Map(Object.entries(choices || {}));
  const store = new Map();
  if (choices !== null) {
    store.set('lib_ConvertigoAssistant.writeConfirm', { get: (key) => (map.has(key) ? map.get(key) : null) });
  }
  return { get: (key) => (store.has(key) ? store.get(key) : null), set: (key, value) => store.set(key, value) };
}

function withGlobals(fakes, run) {
  const saved = {};
  for (const [name, value] of Object.entries(fakes)) { saved[name] = global[name]; global[name] = value; }
  try { return run(); } finally { for (const [name, value] of Object.entries(saved)) global[name] = value; }
}

// "user:studio" as published (raw JSON), for the time of `run`
function withStudioRecord(json, run, extra = {}) {
  const record = json === null ? {} : { 'user:studio': json };
  return withGlobals(Object.assign({ context: { server: serverWith(record) } }, extra), run);
}

// the Studio's choice as the Assistant publishes it (agent_write_confirm.js publish), for the time of `run`
function withStudioMode(mode, run, extra = {}) {
  return withStudioRecord(JSON.stringify({ on: mode !== 'off', mode, at: 1 }), run, extra);
}

test('the Studio choice is read as the MCP reads it, off when nothing or something unreadable is published', () => {
  withGlobals({ context: { server: serverWith(null) } }, () => assert.equal(studioWriteConfirmMode(), 'off'));
  withStudioRecord(null, () => assert.equal(studioWriteConfirmMode(), 'off'));
  for (const mode of ['off', 'confirm', 'readonly']) {
    withStudioMode(mode, () => assert.equal(studioWriteConfirmMode(), mode));
  }
  // an older record names on only
  withStudioRecord(JSON.stringify({ on: true }), () => assert.equal(studioWriteConfirmMode(), 'confirm'));
  withStudioRecord(JSON.stringify({ on: true, mode: 'unknown' }), () => assert.equal(studioWriteConfirmMode(), 'confirm'));
  withStudioRecord('{not json', () => assert.equal(studioWriteConfirmMode(), 'off'));
  // a No Code user's choice is not the Studio's
  withGlobals({ context: { server: serverWith({ 'user:person@example.invalid': JSON.stringify({ on: true, mode: 'readonly' }) }) } },
    () => assert.equal(studioWriteConfirmMode(), 'off'));
  // no shared store at all (a test engine): off
  withGlobals({ context: {}, server: undefined }, () => assert.equal(studioWriteConfirmMode(), 'off'));
});

test('only a Studio conversation runs read only, and only in readonly', () => {
  withStudioMode('readonly', () => {
    assert.equal(studioReadOnly(studio), true);
    assert.equal(studioReadOnly({ userId: 'studio', agentProfile: 'generalist' }), true);
    assert.equal(studioReadOnly(noCode), false, 'a No Code user never runs read only');
    assert.equal(studioReadOnlyProfile('nocode'), false);
    assert.equal(studioReadOnlyProfile('generalist'), true);
    assert.equal(studioReadOnlyProfile('flow'), true);
  });
  for (const mode of ['off', 'confirm']) {
    withStudioMode(mode, () => assert.equal(studioReadOnly(studio), false, mode));
  }
});

test('Vibe: a read-only Studio home has no shell and no file writer, and records it in its intent', () => {
  withStudioMode('readonly', () => {
    assert.equal(vibeToolPolicy(studio), 'studio-readonly-v1');
    assert.deepEqual(vibeToolPolicyLines(studio), ['disabled_tools = ["bash*", "git_bash*", "powershell*", "write_file", "edit"]']);
    // read_file, grep and the MCP stay
    assert.doesNotMatch(vibeToolPolicyLines(studio)[0], /read_file|grep|Convertigo/);
    // a No Code session keeps its own policy (an engine without agents.tool_policy: mcp-only)
    assert.match(vibeToolPolicy(noCode), /^nocode-mcp-only-/);
  });
  withStudioMode('confirm', () => {
    assert.equal(vibeToolPolicy(studio), '', 'out of read only, a Studio home records no tool policy: homes written before stay');
    assert.deepEqual(vibeToolPolicyLines(studio), []);
  });
  // a change of policy writes config.toml again (intent) and restarts a resident process on the same session
  assert.match(source('vibe'), /var expectedToolPolicy = vibeToolPolicy\(options\);\n\s*if \(expectedToolPolicy\.length\) \{\n\s*intentFields\.toolPolicy = expectedToolPolicy;/);
  assert.match(source('vibe'), /var toolPolicyChanged = trim\(existing\.toolPolicy\) !== vibeToolPolicy\(options\);/);
  assert.match(source('vibe'), /entry\.toolPolicy = vibeToolPolicy\(options\);/);
});

function vibeConfig(options) {
  let text = '';
  withGlobals({
    writeTextFile: (_file, value) => { text = String(value); },
    ensureDirectory: () => {},
    vibePlaywrightServer: () => null
  }, () => writeLocalVibeConfig('/managed/vibe-home', 'http://localhost:18080/convertigo/api/mcp', 'glm-5-3', Object.assign({ vibeProfile: 'mistral', model: 'glm-5-3' }, options)));
  return text;
}

test('Vibe: disabled_tools is a top-level key of config.toml, before the first table', () => {
  const readOnly = withStudioMode('readonly', () => vibeConfig(studio));
  const lines = readOnly.split('\n');
  const at = lines.indexOf('disabled_tools = ["bash*", "git_bash*", "powershell*", "write_file", "edit"]');
  assert.ok(at > 0, readOnly);
  assert.ok(at < lines.findIndex((line) => /^\[/.test(line)), 'top level');
  assert.equal(readOnly.split('disabled_tools = ["bash*"').length, 2, 'once');
  assert.doesNotMatch(withStudioMode('off', () => vibeConfig(studio)), /^disabled_tools/m);
});

test('Codex: each turn names its sandbox, read only while the Studio is', () => {
  const studioEntry = { skillProfile: 'generalist', cwd: '/ws', codexThreadId: 'thread-1' };
  withStudioMode('readonly', () => {
    const params = codexTurnParams(studioEntry, {}, 'Change the page', 1);
    assert.deepEqual(params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    assert.equal(params.approvalPolicy, 'never', 'nothing to approve: the sandbox refuses');
    assert.equal(codexThreadParams(studioEntry, {}).sandbox, 'read-only', 'a thread started or resumed read only');
    // a No Code session is not concerned
    assert.deepEqual(codexTurnParams({ skillProfile: 'nocode', cwd: '/ws', codexThreadId: 't' }, {}, 'x', 2).sandboxPolicy, { type: 'dangerFullAccess' });
  });
  withStudioMode('off', () => {
    // the override holds for the next turns: out of read only the turn names the thread's own policy again
    assert.deepEqual(codexTurnParams(studioEntry, {}, 'Change the page', 3).sandboxPolicy, { type: 'dangerFullAccess' });
    assert.equal(codexThreadParams({ skillProfile: 'generalist', cwd: '/ws' }, {}).sandbox, 'danger-full-access');
  });
});

test('Codex: a workspace-write thread keeps its own settings, and gets them back after read only', () => {
  const entry = { skillProfile: 'generalist', cwd: '/ws', codexThreadId: 'thread-2' };
  const options = { bypassApprovalsAndSandbox: 'false' };
  withStudioMode('off', () => assert.equal(codexTurnParams(entry, options, 'a', 1).sandboxPolicy, undefined));
  withStudioMode('readonly', () => assert.equal(codexTurnParams(entry, options, 'b', 2).sandboxPolicy.type, 'readOnly'));
  withStudioMode('off', () => {
    assert.deepEqual(codexTurnParams(entry, options, 'c', 3).sandboxPolicy, { type: 'workspaceWrite' });
    assert.equal(codexTurnParams(entry, options, 'd', 4).sandboxPolicy, undefined, 'once');
  });
  // a thread started read only gets its policy back at its first turn out of it
  const started = { skillProfile: 'generalist', cwd: '/ws', codexThreadId: 'thread-3' };
  withStudioMode('readonly', () => codexThreadParams(started, options));
  withStudioMode('off', () => assert.deepEqual(codexTurnParams(started, options, 'e', 5).sandboxPolicy, { type: 'workspaceWrite' }));
});

test('Codex exec: read only runs in the read-only sandbox, never with the bypass', () => {
  withStudioMode('readonly', () => {
    for (const sessionId of ['', 'session-1']) {
      const command = codexCommand('codex', { skillProfile: 'generalist', sessionId, cwd: '/ws' }, {}, 'x');
      assert.equal(command.indexOf('--dangerously-bypass-approvals-and-sandbox'), -1, command.join(' '));
      assert.equal(command[command.indexOf('sandbox_mode="read-only"') - 1], '-c', command.join(' '));
    }
  });
  withStudioMode('off', () => {
    const command = codexCommand('codex', { skillProfile: 'generalist', sessionId: '', cwd: '/ws' }, {}, 'x');
    assert.ok(command.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!command.includes('sandbox_mode="read-only"'));
  });
});

test('provider runtime: a read-only process is not offered its file writers and shells', () => {
  const withConfig = { claudePath: '/managed/claude', mcpConfigFile: '/home/convertigo-mcp.json', workspaceRoot: '/ws', cwd: '/ws' };
  const readOnly = claudeCommand(Object.assign({ studioReadOnly: true }, withConfig), {});
  assert.equal(readOnly.filter((arg) => arg === '--disallowedTools').length, 1, 'one list');
  const listed = readOnly[readOnly.indexOf('--disallowedTools') + 1].split(',');
  assert.deepEqual(listed, ['mcp__playwright__browser_run_code_unsafe'].concat(READ_ONLY_TOOLS));
  for (const kept of ['Read', 'Glob', 'Grep', 'mcp__convertigo__databaseobject-tree-get']) {
    assert.ok(!listed.includes(kept), kept + ' stays');
  }
  // without the MCP config file (no playwright server), the read-only list alone
  const bare = claudeCommand({ claudePath: '/managed/claude', workspaceRoot: '/ws', cwd: '/ws', studioReadOnly: true }, {});
  assert.deepEqual(bare[bare.indexOf('--disallowedTools') + 1].split(','), READ_ONLY_TOOLS);
  // out of read only, nothing changes
  const off = claudeCommand(Object.assign({ studioReadOnly: false }, withConfig), {});
  assert.equal(off[off.indexOf('--disallowedTools') + 1], 'mcp__playwright__browser_run_code_unsafe');
});

// a resident provider-runtime entry, alive, of the Studio
function residentEntry(readOnly) {
  return { handle: 'claude-1', skillProfile: 'generalist', userId: 'studio', model: 'opus', reasoningEffort: '', studioReadOnly: readOnly,
    sessionId: 'session-1', process: {}, ttlMillis: 600000, convertigoRevealMode: false, home: null };
}

function runtimeFakes(entry, events, stopped) {
  return {
    getRegistry: () => ({ get: (handle) => (handle === entry.handle ? entry : null), put: () => {}, remove: () => {} }),
    processAlive: () => true,
    pushEvent: (_entry, type, data) => events.push(Object.assign({ type }, data)),
    stopEntry: () => { stopped.push(true); },
    noCodeAgentRefusal: () => null,
    userGatewayKeyIsolationRefusal: () => null,
    userGatewayKeyRefusal: () => null,
    userGatewayKeysOn: () => false,
    ensureManagedViewerDebugPort: () => {},
    resolvePlaywrightMcpCdpEndpoint: () => '',
    mcpBearerTokenFingerprint: () => '',
    revealModeEnabled: () => false,
    rememberEntryGatewayKey: () => {},
    writeEntryPidFile: () => {},
    rememberSessionHandle: () => {},
    claudeEndHeldTurn: () => {},
    statusOf: () => ({})
  };
}

test('provider runtime: a change of the Studio mode restarts the process on the same session, at start and at prompt', () => {
  const savedSweep = C8O.agentBridge.sweepExpired;
  const savedSetup = C8O.agentBridge.claudeSetup;
  const savedStart = C8O.agentBridge.claudeStart;
  C8O.agentBridge.sweepExpired = () => {};
  try {
    // start: the same mode reuses the process, another one restarts it
    for (const [running, mode, restarts] of [[false, 'off', false], [false, 'readonly', true], [true, 'readonly', false], [true, 'confirm', true]]) {
      const entry = residentEntry(running);
      const events = [];
      const stopped = [];
      let setupCalls = 0;
      C8O.agentBridge.claudeSetup = () => { setupCalls++; return { ok: false, status: 'error', setup: {}, messages: ['stop here'] }; };
      const result = withStudioMode(mode, () => C8O.agentBridge.claudeStart({ handle: 'claude-1', userId: 'studio', model: 'opus' }), runtimeFakes(entry, events, stopped));
      if (restarts) {
        assert.equal(stopped.length, 1, mode);
        assert.equal(setupCalls, 1, 'started again');
        assert.equal(events[0].reason, 'read_only_changed');
      } else {
        assert.equal(result.status, 'already_running', mode);
        assert.equal(stopped.length, 0);
      }
    }
    // prompt: a process started out of read only restarts before the turn, on its session
    const entry = residentEntry(false);
    const events = [];
    const stopped = [];
    let restartOptions = null;
    C8O.agentBridge.claudeStart = (options) => { restartOptions = options; return { ok: false, error: 'stop here' }; };
    const prompted = withStudioMode('readonly', () => C8O.agentBridge.claudePrompt({ handle: 'claude-1', prompt: 'Change the page' }), runtimeFakes(entry, events, stopped));
    assert.equal(prompted.phase, 'claude_restart');
    assert.equal(events[0].reason, 'read_only_changed');
    assert.equal(stopped.length, 1);
    assert.equal(restartOptions.sessionId, 'session-1');
    assert.equal(restartOptions.skillProfile, 'generalist');
  } finally {
    C8O.agentBridge.sweepExpired = savedSweep;
    C8O.agentBridge.claudeSetup = savedSetup;
    C8O.agentBridge.claudeStart = savedStart;
  }
});

test('the process records the mode it started with, before its command is built', () => {
  const claude = source('claude');
  const recorded = claude.indexOf('entry.studioReadOnly = studioReadOnlyProfile(entry.skillProfile);');
  assert.ok(recorded > 0);
  assert.ok(claude.indexOf('entry.skillProfile = normalizeSkillProfile(options);') < recorded);
  assert.ok(recorded < claude.indexOf('entry.command = claudeCommand(entry, options);'));
});
