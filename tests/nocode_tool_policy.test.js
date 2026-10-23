// A No Code session works through the Convertigo MCP only. On test-nocode a Mistral Large 4 agent ran
// `bash: jq ...` in the engine container: Vibe offers its shell, file and web tools by default and the Bridge
// approved every permission. The No Code config.toml now removes them, a resident No Code process restarts on it,
// and the Bridge refuses a permission asked for any tool that is not a Convertigo MCP one.
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
const noCode = { userId: 'person@example.invalid' };
const studio = { userId: 'studio' };

function writtenConfig(options) {
  let text = null;
  const saved = [global.writeTextFile, global.ensureDirectory];
  global.writeTextFile = (_file, value) => { text = value; };
  global.ensureDirectory = () => {};
  try {
    writeLocalVibeConfig('/tmp/vibe-home', 'http://localhost:18080/convertigo/api/mcp', 'mistral-large-4', options);
  } finally {
    [global.writeTextFile, global.ensureDirectory] = saved;
  }
  return text;
}

test('a No Code config.toml removes the shell, file and web tools before its first table; a Studio one keeps them', () => {
  const lines = writtenConfig(noCode).split('\n');
  const disabled = lines.findIndex(line => line.startsWith('disabled_tools = '));
  assert.ok(disabled > 0 && disabled < lines.indexOf('[[providers]]'), 'a top-level key');
  assert.deepEqual(lines.slice(disabled, disabled + 3), [
    'disabled_tools = ["bash*", "git_bash*", "powershell*", "read_file", "write_file", "edit", "grep", "web_fetch", "web_search", "task"]',
    // run_typescript's own reach to processes and subagents.
    'enable_background_processes = false',
    'enable_subagents = false'
  ]);
  assert.doesNotMatch(writtenConfig(studio), /disabled_tools|enable_background_processes|enable_subagents/);
  assert.equal(vibeToolPolicy(noCode), 'nocode-builtins-off-v1');
  assert.equal(vibeToolPolicy(studio), '');
});

test('a No Code home records its tool policy in the config intent, so an existing home is rewritten once', () => {
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

test('a No Code session refuses a permission for a tool that is not a Convertigo MCP one', () => {
  const entry = { toolPolicy: vibeToolPolicy(noCode) };
  const savedPush = global.pushEvent;
  global.pushEvent = () => {};
  try {
    // Titles as the run of test-nocode shows them, the tool_call update before the permission request.
    normalizeSessionUpdate(entry, { update: { sessionUpdate: 'tool_call', toolCallId: 'effect-5675b7de', title: 'bash: jq -r .workspaces[] /workspace/agents/vibe/x.json', status: 'pending' } });
    normalizeSessionUpdate(entry, { update: { sessionUpdate: 'tool_call', toolCallId: 'effect-39886a25', title: 'mcp_Convertigo.nocode_baserow_catalog_list', status: 'pending' } });
  } finally {
    global.pushEvent = savedPush;
  }
  const shell = permissionAnswers(entry, { toolCallId: 'effect-5675b7de' });
  assert.deepEqual(shell.outcome, { outcome: 'selected', optionId: 'reject_once' });
  const refused = shell.events.find(e => e.type === 'permission/refused');
  assert.deepEqual([refused.data.reason, refused.data.title], ['nocode_tool_policy', 'bash: jq -r .workspaces[] /workspace/agents/vibe/x.json']);
  assert.deepEqual(permissionAnswers(entry, { toolCallId: 'effect-39886a25' }).outcome, { outcome: 'selected', optionId: 'allow_once' });
  assert.deepEqual(permissionAnswers(entry, { toolCallId: 'Convertigo_nocode-form-get' }).outcome, { outcome: 'selected', optionId: 'allow_once' }, 'a direct MCP call');
  assert.deepEqual(permissionAnswers(entry, { toolCallId: 'file_system.bash' }).outcome, { outcome: 'selected', optionId: 'reject_once' }, 'an id Vibe built from the tool name');
  assert.deepEqual(permissionAnswers(entry, { toolCallId: 'effect-unknown' }).outcome, { outcome: 'selected', optionId: 'allow_once' }, 'a call never seen is left to the config');
});

test('a Studio session keeps approving its permissions', () => {
  const entry = { toolPolicy: vibeToolPolicy(studio) };
  assert.deepEqual(permissionAnswers(entry, { toolCallId: 'file_system.bash', title: 'bash: npm test' }).outcome, { outcome: 'selected', optionId: 'allow_once' });
  assert.deepEqual(permissionAnswers({}, { toolCallId: 'file_system.bash', title: 'bash: npm test' }).outcome, { outcome: 'selected', optionId: 'allow_once' }, 'a Codex or Claude entry');
});

test('the remembered tool titles stay bounded', () => {
  const entry = {};
  for (let i = 0; i < 250; i++) rememberToolCallTitle(entry, 'effect-' + i, 'mcp_Convertigo.tool_' + i);
  assert.equal(Object.keys(entry.toolCallTitles).length, 200);
  assert.equal(entry.toolCallTitles['effect-0'], undefined);
  assert.equal(entry.toolCallTitles['effect-249'], 'mcp_Convertigo.tool_249');
});
