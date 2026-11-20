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
  // the rows of the tables the turn context names: straight to the two tools, the rows answered as the proof
  assert.match(text, /A request only about the rows of the tables the turn context names \(sample data to add, rows to change or delete\) needs neither the skill, its drawers nor a tool search/, provider);
  assert.match(text, /Its answer lists the rows written \(rows, with their ids\): that is the proof, read nothing afterwards\./, provider);
  assert.match(text, /editing it; reading or writing its data needs no form read\./, provider);
  if (provider === 'vibe') {
    assert.match(text, /in run_typescript, read the columns with tools\.mcp_Convertigo\.nocode_baserow_catalog_list\(\{ tableId, includeColumns: true, view: "compact" \}\)/);
    assert.match(text, /tools\.mcp_Convertigo\.nocode_baserow_schema_apply\(\{ mode: "apply", view: "compact", schema: \{ baseId, tables: \[\{ id, name, sampleRows: \[\.\.\.\], upsertKey \}\] \} \}\)/);
  } else {
    assert.match(text, /nocode-baserow-schema-apply \{ mode: "apply"/, provider);
  }
}
console.log('no-code agent instructions ok');
