// The Convertigo MCP server of a Vibe session names the Tigo conversation (X-Convertigo-Conversation-Id), so the
// sub-agent tools record their runs under it, and nocode-form-preview-capture its requests; a malformed id is left out.
// node tests/mcp_conversation_header.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const javaProxy = new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';return javaProxy;},apply(){return javaProxy;},construct(){return javaProxy;}});
global.Packages=javaProxy;global.context=javaProxy;global.C8O={agentBridge:{}};
for(const name of ['common','codex','claude'])vm.runInThisContext(fs.readFileSync('js/agent_bridge_'+name+'.js','utf8'));
tigoVibeServers = () => [];

const headersOf = options => buildMcpServers('http://localhost:18112/convertigo/api/mcp', options)[0].headers;
const named = (headers, name) => headers.filter(h => h.name === name).map(h => h.value);
let headers = headersOf({ conversationId: 'agent-e50aebd1-3413-4e84-9030-0d4d395a3cb6', viewerDebugPort: 45991 });
assert.deepEqual(named(headers, 'X-Convertigo-Conversation-Id'), ['agent-e50aebd1-3413-4e84-9030-0d4d395a3cb6']);
assert.deepEqual(named(headers, 'X-Convertigo-Viewer-Debug-Port'), ['45991']);
headers = headersOf({ threadid: 'agent-1' });
assert.deepEqual(named(headers, 'X-Convertigo-Conversation-Id'), ['agent-1'], 'the thread id stands for the conversation');
assert.deepEqual(named(headersOf({ conversationId: 'bad id"' }), 'X-Convertigo-Conversation-Id'), []);
headers = headersOf({ conversationId: 'agent-2', skillProfile: 'nocode', viewerDebugPort: 45991 });
assert.deepEqual(named(headers, 'X-Convertigo-Conversation-Id'), ['agent-2'], 'in NoCode too: the preview captures wait under it');
assert.deepEqual(named(headers, 'X-Convertigo-Viewer-Debug-Port'), [], 'NoCode drives no viewer');
assert.equal(mcpConversationId({ handle: 'agent-3' }), 'agent-3');
console.log('conversation header ok');
