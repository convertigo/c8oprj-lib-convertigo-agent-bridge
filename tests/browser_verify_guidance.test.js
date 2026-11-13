// The agent instructions send functional and visual browser proofs to the browser-verify sub-agent of the Convertigo
// MCP; Flow sessions, which do not use that MCP surface, prove with the dedicated Playwright tools.
// node tests/browser_verify_guidance.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const javaProxy = new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';return javaProxy;},apply(){return javaProxy;},construct(){return javaProxy;}});
global.Packages=javaProxy;global.context=javaProxy;global.C8O={agentBridge:{}};
for(const name of ['common','codex','claude'])vm.runInThisContext(fs.readFileSync('js/agent_bridge_'+name+'.js','utf8'));

for (const provider of ['vibe', 'codex', 'claude']) {
  const text = agentSkillInstructions(provider, '');
  assert.match(text, /Delegate each functional and visual browser proof .* to a verifier sub-agent, the Convertigo MCP tool `subagent-run` with `profile:"verifier"`/, provider);
  assert.match(text, /`paths` = one plain-language path per user journey/, provider);
  assert.match(text, /it never edits the project/, provider);
  assert.match(text, /verify the affected paths again/, provider);
  assert.match(text, /call it again with the id alone \(`runId`, or `verificationId` for `browser-verify`\) until the report comes/, provider);
  assert.doesNotMatch(text, /For a functional proof \(a login/, provider + ': the Flow proof is not theirs');
  assert.match(text, /Hand each build lot .* to a constructor sub-agent, `subagent-run` with `profile:"constructor"` and `inputs.project`/, provider);
}
// A Studio without the Flow capability falls back to the generalist profile: pretend it has it.
flowCapabilityAvailable = () => true;
const flow = agentSkillInstructions('codex', 'flow');
assert.equal(agentCapabilityProfile({ agentProfile: 'flow' }).id, 'flow');
assert.doesNotMatch(flow, /browser-verify/, 'Flow sessions do not use the legacy MCP tool');
assert.match(flow, /For a functional proof \(a login/);
assert.doesNotMatch(flow, /constructor sub-agent/, 'Flow sessions do not use the legacy MCP tools');
// A download of the Studio viewer raises no Playwright download event: the instructions say to read the folder.
for (const text of [flow, agentSkillInstructions('claude', 'flow'), agentSkillInstructions('codex', '')]) {
  assert.match(text, /`page\.waitForEvent\('download'\)` never fires there: click, then wait for the file to appear in `\.playwright-mcp\/downloads\/`/);
}
console.log('browser-verify guidance ok');
