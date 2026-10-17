const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Opening a conversation calls agent_settings with that conversation's id in the request. The
// storage purge run by settings() must never turn into an exact-conversation cleanup: that path
// stops the agent process, so a viewer opening a running conversation killed its turn.
const common = fs.readFileSync('js/agent_bridge_common.js', 'utf8');
const extract = (pattern) => {
  const match = common.match(pattern);
  assert.ok(match, 'source not found: ' + pattern);
  return match[0];
};

let request = {};
const stopped = [];
const swept = [];
const sandbox = {
  C8O: { agentBridge: {} },
  File: function File(parent, child) { this.path = String(parent && parent.path || parent) + '/' + child; },
  DEFAULT_STORAGE_CLEANUP_INTERVAL_MS: 3600000,
  STORAGE_CLEANUP_FILE: 'storage-cleanup.json',
  trim: (value) => String(value === null || value === undefined ? '' : value).trim(),
  now: () => 1000,
  requestParameter: (name) => (request[name] === undefined ? '' : String(request[name])),
  resolveWorkspaceRoot: (options) => options.workspaceRoot || '/ws',
  intValue: (value, fallback) => (String(value || '').trim() === '' ? fallback : Number(value)),
  boolValue: (value, fallback) => (String(value === undefined || value === null ? '' : value).trim() === '' ? fallback === true : value === true || value === 'true'),
  readJsonFile: () => null,
  writeJsonFile: () => {},
  filePath: (file) => file.path,
  cleanupConversationArtifacts: (options) => stopped.push(options.conversationId || options.threadid || options.handle),
  cleanupOrphanedAgentStorage: (options) => swept.push(options.workspaceRoot)
};
const settings = extract(/C8O\.agentBridge\.settings = function \(options\) \{[\s\S]*?\n  \};/);
// The storage cleanup statement settings() really runs, evaluated as is.
const settingsCleanup = settings.match(/var storageCleanup = ([\s\S]*?\}\));/)[1];
vm.runInNewContext([
  extract(/function optionsWithRequestFallbacks\(options\) \{[\s\S]*?\n  \}/),
  extract(/C8O\.agentBridge\.cleanupStorage = function \(options\) \{[\s\S]*?\n  \};/),
  (common.match(/function cleanupAgentStorage\(options\) \{[\s\S]*?\n  \}/) || [''])[0],
  'this.settingsCleanup = function (settingsWorkspaceRoot) { return ' + settingsCleanup + '; };'
].join('\n'), sandbox);

// What settings() runs while the request names a running conversation: orphan purge only.
request = { conversationId: 'agent-running', threadid: 'agent-running', handle: 'agent-running' };
const report = sandbox.settingsCleanup('/ws');
assert.deepEqual(stopped, [], 'the settings purge must not stop the conversation named by the request');
assert.deepEqual(swept, ['/ws']);
assert.equal(report.nextCleanupAt, 1000 + 3600000);

// agent_cleanup_storage keeps its exact-conversation cleanup (conversation deletion).
sandbox.C8O.agentBridge.cleanupStorage({ workspaceRoot: '/ws', conversationId: 'agent-deleted' });
assert.deepEqual(stopped, ['agent-deleted']);
// ... including when the conversation only comes from the request, as before.
request = { conversationId: 'agent-from-request' };
sandbox.C8O.agentBridge.cleanupStorage({ workspaceRoot: '/ws' });
assert.deepEqual(stopped, ['agent-deleted', 'agent-from-request']);

// settings() must call the request-free purge, not the public request-aware entry point.
assert.match(settings, /cleanupAgentStorage\(\{\s*workspaceRoot: settingsWorkspaceRoot\s*\}\)/);
assert.doesNotMatch(settings, /C8O\.agentBridge\.cleanupStorage\(/);
assert.doesNotMatch(extract(/function cleanupAgentStorage\(options\) \{[\s\S]*?\n  \}/), /optionsWithRequestFallbacks|requestParameter/);

console.log('Settings storage cleanup tests passed');
