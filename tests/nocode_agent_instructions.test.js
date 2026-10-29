// The AGENTS.md of a No Code session names the tools its MCP token reaches: the no-code tools only. It offered
// log-view, which the No Code token is refused and the convertigo-nocode skill forbids.
// node tests/nocode_agent_instructions.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const javaProxy = new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';return javaProxy;},apply(){return javaProxy;},construct(){return javaProxy;}});
global.Packages=javaProxy;global.context=javaProxy;global.C8O={agentBridge:{}};
for(const name of ['common','codex','claude'])vm.runInThisContext(fs.readFileSync('js/agent_bridge_'+name+'.js','utf8'));

for (const provider of ['vibe', 'codex', 'claude']) {
  const text = agentSkillInstructions(provider, 'nocode');
  assert.match(text, /^# Convertigo No Code Agent Instructions/, provider);
  assert.doesNotMatch(text, /plus log-view/, provider + ': log-view is not a no-code tool');
  assert.match(text, /no log-view/, provider);
  assert.match(text, /nocode-report-create when it is listed/, provider);
  assert.match(text, /nocode-app-create, nocode-form-\*/, provider + ': the application fast path is a no-code tool');
  assert.match(text, /call nocode-app-create once with the business spec/, provider);
  // the panel sends nothing during a turn: a question waits for the next message, not for a tool
  assert.match(text, /ask it in your final message and end the turn/, provider);
}
console.log('no-code agent instructions ok');
