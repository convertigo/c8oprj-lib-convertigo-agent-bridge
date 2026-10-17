// The agent instructions send functional and visual browser proofs to the browser-verify sub-agent of the Convertigo
// MCP; Flow sessions, which do not use that MCP surface, keep the scripted Playwright proof.
// node tests/browser_verify_guidance.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const javaProxy = new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';return javaProxy;},apply(){return javaProxy;},construct(){return javaProxy;}});
global.Packages=javaProxy;global.context=javaProxy;global.C8O={agentBridge:{}};
for(const name of ['common','codex','claude'])vm.runInThisContext(fs.readFileSync('js/agent_bridge_'+name+'.js','utf8'));

for (const provider of ['vibe', 'codex', 'claude']) {
  const text = agentSkillInstructions(provider, '');
  assert.match(text, /Delegate each functional and visual browser proof .* to the Convertigo MCP tool `browser-verify`/, provider);
  assert.match(text, /`paths` = one plain-language path per user journey/, provider);
  assert.match(text, /it never edits the project/, provider);
  assert.match(text, /verify the affected paths again/, provider);
  assert.match(text, /call it again with `verificationId` alone until the report comes/, provider);
  assert.doesNotMatch(text, /For a functional proof \(a login/, provider + ': the scripted proof is only the fallback');
}
// A Studio without the Flow capability falls back to the generalist profile: pretend it has it.
flowCapabilityAvailable = () => true;
const flow = agentSkillInstructions('codex', 'flow');
assert.equal(agentCapabilityProfile({ agentProfile: 'flow' }).id, 'flow');
assert.doesNotMatch(flow, /browser-verify/, 'Flow sessions do not use the legacy MCP tool');
assert.match(flow, /For a functional proof \(a login/);
console.log('browser-verify guidance ok');
